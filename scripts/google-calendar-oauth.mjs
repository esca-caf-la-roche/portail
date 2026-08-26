import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { google } from "googleapis";

const CALENDAR_ACCOUNT = "escalade@caflarochebonneville.fr";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
const DEFAULT_CALLBACK_PATH = "/oauth2callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function configurationArguments() {
  const options = process.argv.slice(2);
  if (
    (options.length !== 1 && options.length !== 2) ||
    !["--dev", "--prod", "--both"].includes(options[0])
  ) {
    throw new Error(
      "Usage : npm run google-calendar:oauth -- --dev|--prod|--both [chemin/vers/client_secret.json]",
    );
  }
  return {
    deployments: options[0] === "--both"
      ? [["--deployment", "dev"], ["--prod"]]
      : [options[0] === "--prod" ? ["--prod"] : ["--deployment", "dev"]],
    credentialsPath: options[1] ? resolve(options[1]) : undefined,
  };
}

async function oauthCredentials(credentialsPath) {
  if (!credentialsPath) {
    const clientId = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
    if (clientId && clientSecret) return { clientId, clientSecret };
    throw new Error(
      "Fournissez le fichier JSON OAuth ou les variables GOOGLE_CALENDAR_OAUTH_CLIENT_ID et GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET.",
    );
  }
  let document;
  try {
    document = JSON.parse(await readFile(credentialsPath, "utf8"));
  } catch {
    throw new Error(
      "Le fichier d'identifiants OAuth est introuvable ou invalide.",
    );
  }
  const clientId = document?.installed?.client_id;
  const clientSecret = document?.installed?.client_secret;
  if (typeof clientId === "string" && typeof clientSecret === "string") {
    return { clientId, clientSecret };
  }
  const webClientId = document?.web?.client_id;
  const webClientSecret = document?.web?.client_secret;
  const redirectUri = document?.web?.redirect_uris?.find((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    } catch {
      return false;
    }
  });
  if (
    typeof webClientId !== "string" ||
    typeof webClientSecret !== "string" ||
    typeof redirectUri !== "string"
  ) {
    throw new Error(
      "Utilisez un client OAuth « Application de bureau » ou un client Web avec une redirection HTTP localhost.",
    );
  }
  return { clientId: webClientId, clientSecret: webClientSecret, redirectUri };
}

function attendreCodeOAuth(state, configuredRedirectUri) {
  const configuredUrl = configuredRedirectUri ? new URL(configuredRedirectUri) : null;
  const callbackPath = configuredUrl?.pathname ?? DEFAULT_CALLBACK_PATH;
  let terminer;
  let echouer;
  const codePromise = new Promise((resolve, reject) => {
    terminer = resolve;
    echouer = reject;
  });
  let traite = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== callbackPath) {
      response.writeHead(404).end("Page introuvable");
      return;
    }
    const erreurOAuth = url.searchParams.get("error");
    const receivedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (erreurOAuth || receivedState !== state || !code) {
      response
        .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Autorisation refusée ou réponse OAuth invalide. Vous pouvez fermer cette page.");
      if (erreurOAuth && receivedState === state) {
        echouer(new Error("Google n'a pas fourni une autorisation OAuth valide."));
      }
      return;
    }
    if (traite) {
      response.writeHead(409).end("Autorisation déjà traitée");
      return;
    }
    traite = true;
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Google Calendar est autorisé. Vous pouvez fermer cette page.");
    terminer(code);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const hostname = configuredUrl?.hostname ?? "127.0.0.1";
    const port = configuredUrl ? Number(configuredUrl.port || 80) : 0;
    server.listen(port, hostname, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Impossible d'ouvrir le callback OAuth local."));
        return;
      }
      resolve({
        redirectUri: configuredRedirectUri ?? `http://127.0.0.1:${address.port}${DEFAULT_CALLBACK_PATH}`,
        codePromise,
        fermer: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function avecDelai(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Délai OAuth dépassé. Relancez la commande.")),
          CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function definirVariablesConvex({
  clientId,
  clientSecret,
  refreshToken,
  deploymentArgs,
}) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const convexCli = join(scriptDirectory, "..", "node_modules", "convex", "bin", "main.js");
  const child = spawn(
    process.execPath,
    [convexCli, "env", "set", "--force", ...deploymentArgs],
    { cwd: join(scriptDirectory, ".."), stdio: ["pipe", "ignore", "ignore"] },
  );
  child.stdin.end([
    `GOOGLE_CALENDAR_OAUTH_CLIENT_ID=${JSON.stringify(clientId)}`,
    `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=${JSON.stringify(clientSecret)}`,
    `GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN=${JSON.stringify(refreshToken)}`,
    "",
  ].join("\n"));

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `Impossible de configurer Convex (code ${exitCode}). Vérifiez votre connexion Convex et la cible choisie.`,
    );
  }
}

async function main() {
  const { deployments, credentialsPath } = configurationArguments();
  const { clientId, clientSecret, redirectUri } = await oauthCredentials(credentialsPath);
  const state = randomBytes(32).toString("hex");
  const callback = await attendreCodeOAuth(state, redirectUri);
  const auth = new google.auth.OAuth2(clientId, clientSecret, callback.redirectUri);

  try {
    const authorizationUrl = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
      login_hint: CALENDAR_ACCOUNT,
    });
    console.log("Ouvrez cette URL dans votre navigateur puis connectez-vous avec le compte du club :");
    console.log(authorizationUrl);

    const code = await avecDelai(callback.codePromise);
    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "Google n'a pas renvoyé de refresh token. Révoquez l'ancien accès puis relancez la commande.",
      );
    }
    auth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth });
    const identity = await oauth2.userinfo.get();
    if (identity.data.email?.toLowerCase() !== CALENDAR_ACCOUNT) {
      throw new Error(
        `Mauvais compte Google connecté. Utilisez uniquement ${CALENDAR_ACCOUNT}.`,
      );
    }

    for (const deploymentArgs of deployments) {
      await definirVariablesConvex({
        clientId,
        clientSecret,
        refreshToken: tokens.refresh_token,
        deploymentArgs,
      });
    }
    console.log(
      `Autorisation enregistrée dans Convex pour ${CALENDAR_ACCOUNT}. Aucun secret n'a été affiché ni écrit sur disque.`,
    );
  } finally {
    auth.setCredentials({});
    await callback.fermer();
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "Échec de l'autorisation OAuth.");
  process.exitCode = 1;
});
