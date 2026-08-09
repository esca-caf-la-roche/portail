// Synchronisation à la demande des règlements préparés par n8n. Le webhook
// renvoie uniquement des métadonnées : les PDF sont déjà archivés dans Drive.

import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "../customFunctions";
import { internalMutation } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { champsModifies } from "../dbUtils";
import { normaliserNomPrenom } from "./lib";
import { REGLEMENT_VERSION } from "./reglementsConstants";

const MAX_ITEMS = 1_000;
const TAILLE_LOT = 100;
const MAX_LONGUEUR_IDENTITE = 100;
const MAX_LONGUEUR_DRIVE_ID = 200;
const MAX_TAILLE_REPONSE = 1_000_000;
const TIMEOUT_WEBHOOK_MS = 15_000;
const WEBHOOK_URL_AUTORISEE =
  "https://n8n.jpcloudkit.fr/webhook/reglement-int-sae";

type ItemWebhook = {
  nom: string;
  prenom: string;
  driveFileId: string;
};

const itemWebhookValidator = v.object({
  nom: v.string(),
  prenom: v.string(),
  driveFileId: v.string(),
});

const statsValidator = v.object({
  recus: v.number(),
  crees: v.number(),
  actualises: v.number(),
  ignores: v.number(),
});

function erreurJson(message: string): never {
  throw new ConvexError({
    code: "REGLEMENT_WEBHOOK_JSON_INVALIDE",
    message,
  });
}

function lireTexte(
  row: Record<string, unknown>,
  cle: "NOM" | "Prénom" | "id-drive",
  index: number,
): string {
  const valeur = row[cle];
  if (typeof valeur !== "string" || !valeur.trim()) {
    return erreurJson(`L'élément ${index + 1} doit contenir le champ « ${cle} ».`);
  }
  return valeur.trim();
}

export function validerReponseWebhook(value: unknown): ItemWebhook[] {
  for (let profondeur = 0; profondeur < 3 && typeof value === "string"; profondeur++) {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return erreurJson("Le webhook n'a pas renvoyé un JSON valide.");
    }
  }
  if (value === null) return [];
  if (!Array.isArray(value)) {
    return erreurJson("Le webhook doit renvoyer un tableau JSON.");
  }
  if (value.length > MAX_ITEMS) {
    return erreurJson("Le webhook ne peut pas renvoyer plus de 1 000 règlements.");
  }

  const uniques = new Map<string, ItemWebhook>();
  value.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      erreurJson(`L'élément ${index + 1} doit être un objet JSON.`);
    }
    const row = item as Record<string, unknown>;
    const nom = lireTexte(row, "NOM", index);
    const prenom = lireTexte(row, "Prénom", index);
    const driveFileId = lireTexte(row, "id-drive", index);
    if (
      nom.length > MAX_LONGUEUR_IDENTITE ||
      prenom.length > MAX_LONGUEUR_IDENTITE
    ) {
      erreurJson(`Le nom et le prénom de l'élément ${index + 1} sont trop longs.`);
    }
    if (
      driveFileId.length > MAX_LONGUEUR_DRIVE_ID ||
      !/^[A-Za-z0-9_-]+$/.test(driveFileId)
    ) {
      erreurJson(`L'identifiant Drive de l'élément ${index + 1} est invalide.`);
    }
    const precedent = uniques.get(driveFileId);
    if (
      precedent &&
      normaliserNomPrenom(precedent.nom, precedent.prenom) !==
        normaliserNomPrenom(nom, prenom)
    ) {
      erreurJson(
        `Le fichier Drive de l'élément ${index + 1} est associé à deux identités différentes.`,
      );
    }
    uniques.set(driveFileId, { nom, prenom, driveFileId });
  });
  return [...uniques.values()];
}

export const enregistrerResultat = internalMutation({
  args: { items: v.array(itemWebhookValidator), synchroniseLe: v.string() },
  returns: v.object({
    crees: v.number(),
    actualises: v.number(),
    ignores: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.items.length > TAILLE_LOT) {
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_LOT_INVALIDE",
        message: "Un lot interne ne peut pas dépasser 100 règlements.",
      });
    }
    let crees = 0;
    let actualises = 0;
    let ignores = 0;

    for (const item of args.items) {
      const [existant, dejaArchive] = await Promise.all([
        ctx.db
          .query("abo_reglements_imports")
          .withIndex("by_drive_file_id", (q) =>
            q.eq("drive_file_id", item.driveFileId),
          )
          .unique(),
        ctx.db
          .query("abo_reglements_signes")
          .withIndex("by_drive_file_id", (q) =>
            q.eq("drive_file_id", item.driveFileId),
          )
          .unique(),
      ]);
      if (dejaArchive) {
        ignores += 1;
        continue;
      }
      const driveFileName = `${item.nom} ${item.prenom}.pdf`;
      const driveUrl = `https://drive.google.com/open?id=${encodeURIComponent(item.driveFileId)}`;
      const identiteExtraite = `${item.nom} ${item.prenom}`;
      const nomPrenomNormalise = normaliserNomPrenom(item.nom, item.prenom);

      if (!existant) {
        await ctx.db.insert("abo_reglements_imports", {
          drive_file_id: item.driveFileId,
          drive_file_name: driveFileName,
          drive_url: driveUrl,
          version_reglement: REGLEMENT_VERSION,
          identite_extraite: identiteExtraite,
          nom_extrait: item.nom,
          prenom_extrait: item.prenom,
          nom_prenom_normalise: nomPrenomNormalise,
          statut: "a_rapprocher",
          importe_le: args.synchroniseLe,
          derniere_tentative_le: args.synchroniseLe,
        });
        crees += 1;
        continue;
      }

      const patch = {
        drive_file_name: driveFileName,
        drive_url: driveUrl,
        version_reglement: REGLEMENT_VERSION,
        identite_extraite: identiteExtraite,
        nom_extrait: item.nom,
        prenom_extrait: item.prenom,
        nom_prenom_normalise: nomPrenomNormalise,
        statut: existant.statut === "lie" ? ("lie" as const) : ("a_rapprocher" as const),
        erreur_code: undefined,
      };
      if (!champsModifies(existant as Doc<"abo_reglements_imports">, patch)) {
        ignores += 1;
        continue;
      }
      await ctx.db.patch(existant._id, {
        ...patch,
        derniere_tentative_le: args.synchroniseLe,
      });
      actualises += 1;
    }
    return { crees, actualises, ignores };
  },
});

export const synchroniser = authenticatedAction({
  args: {},
  returns: statsValidator,
  handler: async (ctx): Promise<{
    recus: number;
    crees: number;
    actualises: number;
    ignores: number;
  }> => {
    const me = await ctx.runQuery(api.abo.identity.me, {});
    if (!me || me.aboRole !== "admin") {
      throw new ConvexError({
        code: "42501",
        message: "Réservé aux administrateurs Abonnements.",
      });
    }
    const url = process.env.ABO_REGLEMENTS_WEBHOOK_URL;
    const user = process.env.ABO_REGLEMENTS_WEBHOOK_USER;
    const password = process.env.ABO_REGLEMENTS_WEBHOOK_PASSWORD;
    if (!url || !user || !password) {
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_CONFIGURATION",
        message: "Le webhook des règlements n'est pas configuré.",
      });
    }
    let urlWebhook: URL;
    try {
      urlWebhook = new URL(url);
    } catch {
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_CONFIGURATION",
        message: "L'URL du webhook des règlements est invalide.",
      });
    }
    if (urlWebhook.href !== WEBHOOK_URL_AUTORISEE) {
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_URL_INTERDITE",
        message: "L'URL du webhook des règlements n'est pas autorisée.",
      });
    }

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_WEBHOOK_MS);
    try {
      response = await fetch(urlWebhook, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${btoa(`${user}:${password}`)}`,
        },
      });
    } catch {
      clearTimeout(timeout);
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_INDISPONIBLE",
        message: "Le webhook des règlements est indisponible.",
      });
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_HTTP",
        message: `Le webhook des règlements a répondu avec le statut ${response.status}.`,
      });
    }
    const longueurAnnoncee = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(longueurAnnoncee) &&
      longueurAnnoncee > MAX_TAILLE_REPONSE
    ) {
      clearTimeout(timeout);
      erreurJson("La réponse du webhook est trop volumineuse.");
    }
    let texte: string;
    try {
      texte = await response.text();
    } catch {
      throw new ConvexError({
        code: "REGLEMENT_WEBHOOK_INDISPONIBLE",
        message: "La réponse du webhook des règlements est incomplète.",
      });
    } finally {
      clearTimeout(timeout);
    }
    if (new TextEncoder().encode(texte).byteLength > MAX_TAILLE_REPONSE) {
      erreurJson("La réponse du webhook est trop volumineuse.");
    }
    const items = validerReponseWebhook(texte);
    const total = { crees: 0, actualises: 0, ignores: 0 };
    const synchroniseLe = new Date().toISOString();
    for (let debut = 0; debut < items.length; debut += TAILLE_LOT) {
      const stats = await ctx.runMutation(
        internal.abo.reglementsWebhook.enregistrerResultat,
        { items: items.slice(debut, debut + TAILLE_LOT), synchroniseLe },
      );
      total.crees += stats.crees;
      total.actualises += stats.actualises;
      total.ignores += stats.ignores;
    }
    return { recus: items.length, ...total };
  },
});
