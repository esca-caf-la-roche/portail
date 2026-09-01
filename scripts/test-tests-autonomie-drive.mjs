import { google } from "googleapis";

const nom = process.argv[2]?.trim();
if (!nom) {
  throw new Error("Usage : node scripts/test-tests-autonomie-drive.mjs <nom-ou-debut-de-nom>");
}

const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const driveId = process.env.ABO_REGLEMENTS_DRIVE_ID;
const rootFolderId = process.env.ABO_TESTS_DRIVE_ROOT_FOLDER_ID;
if (!email || !privateKey || !driveId || !rootFolderId) {
  throw new Error("Les variables Drive de test ne sont pas toutes définies.");
}

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: email, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth });
const echapper = (value) => value.replaceAll("'", "\\'");
const initiale = nom
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")[0]
  ?.toLocaleUpperCase("fr-FR");

const racine = await drive.files.get({
  fileId: rootFolderId,
  supportsAllDrives: true,
  fields: "id,name,mimeType,driveId,parents",
});
console.log(`Racine accessible : ${racine.data.name} (${racine.data.id})`);
if (racine.data.parents?.[0]) {
  const parent = await drive.files.get({
    fileId: racine.data.parents[0],
    supportsAllDrives: true,
    fields: "id,name",
  });
  console.log(`Dossier parent : ${parent.data.name} (${parent.data.id})`);
}

const dossiers = await drive.files.list({
  q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  corpora: "drive",
  driveId,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  fields: "files(id,name)",
  pageSize: 100,
});
console.log(`Sous-dossiers : ${(dossiers.data.files ?? []).map((dossier) => dossier.name).join(", ") || "aucun"}`);

const dossier = (dossiers.data.files ?? []).find((item) => item.name === initiale);
if (!dossier?.id) {
  throw new Error(`Sous-dossier ${initiale} introuvable sous la racine configurée.`);
}

const fichiers = await drive.files.list({
  q: `name contains '${echapper(nom.toLocaleUpperCase("fr-FR"))}' and '${dossier.id}' in parents and trashed=false`,
  corpora: "drive",
  driveId,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  fields: "files(id,name,webViewLink)",
  pageSize: 20,
});
console.log(`Dossier ${initiale} : ${(fichiers.data.files ?? []).length} fichier(s) pour « ${nom} »`);
for (const fichier of fichiers.data.files ?? []) {
  console.log(`- ${fichier.name} (${fichier.id})`);
}
