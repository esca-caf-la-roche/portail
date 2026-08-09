"use node";

// Briques Google Drive communes aux archives permanentes Abonnements.
// Les actions appelantes fournissent uniquement leur Drive, leur dossier racine
// et leurs règles de format/recherche.

import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import { ConvexError } from "convex/values";
import {
  echapperRequeteDrive,
  preparerRechercheDrive,
} from "./driveArchivesRecherche";

export { echapperRequeteDrive, initialeNom, prenomTitre } from "./driveArchivesRecherche";

export type FichierDriveTrouve = {
  driveFileId: string;
  driveUrl: string;
  nomFichier: string;
};

type ConfigurationDrive = {
  driveId?: string;
  rootFolderId?: string;
  scope: "lecture" | "ecriture";
  messageConfiguration: string;
};

type RechercheDrive = {
  drive: ReturnType<typeof google.drive>;
  driveId: string;
  rootFolderId: string;
  nom: string;
  prenom: string;
  mimeTypes?: string[];
  maximum?: number;
};

export function configurationDrive({
  driveId,
  rootFolderId,
  scope,
  messageConfiguration,
}: ConfigurationDrive) {
  const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !privateKey || !driveId || !rootFolderId) {
    throw new ConvexError({
      code: "DRIVE_CONFIGURATION",
      message: messageConfiguration,
    });
  }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: [
      scope === "ecriture"
        ? "https://www.googleapis.com/auth/drive"
        : "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  return {
    drive: google.drive({ version: "v3", auth }),
    driveId,
    rootFolderId,
  };
}

export async function verifierAccesRacine(
  drive: ReturnType<typeof google.drive>,
  rootFolderId: string,
  messageInaccessible: string,
) {
  try {
    await drive.files.get({
      fileId: rootFolderId,
      supportsAllDrives: true,
      fields: "id",
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 404
    ) {
      throw new ConvexError({
        code: "DRIVE_DOSSIER_INACCESSIBLE",
        message: messageInaccessible,
      });
    }
    throw error;
  }
}

export async function dossierInitiale(
  drive: ReturnType<typeof google.drive>,
  driveId: string,
  rootFolderId: string,
  initiale: string,
  creerSiAbsent = true,
): Promise<string | null> {
  const resultat = await drive.files.list({
    q: `name='${echapperRequeteDrive(initiale)}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`,
    corpora: "drive",
    driveId,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id)",
    pageSize: 2,
  });
  const existant = resultat.data.files?.[0]?.id;
  if (existant) return existant;
  if (!creerSiAbsent) return null;
  const cree = await drive.files.create({
    requestBody: {
      name: initiale,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootFolderId],
    },
    supportsAllDrives: true,
    fields: "id",
  });
  if (!cree.data.id) {
    throw new ConvexError({
      code: "DRIVE_DOSSIER",
      message: "Impossible de créer le dossier Drive du candidat.",
    });
  }
  return cree.data.id;
}

export async function rechercherFichiersDrive({
  drive,
  driveId,
  rootFolderId,
  nom,
  prenom,
  mimeTypes,
  maximum = 20,
}: RechercheDrive): Promise<FichierDriveTrouve[]> {
  const nomRecherche = nom.trim();
  const prenomRecherche = prenom.trim();
  if (!nomRecherche && !prenomRecherche) return [];

  // Un fragment peut commencer au milieu du nom ("her" pour "DUHERON"). On
  // parcourt donc les dossiers d'initiale, avec celui de l'initiale saisie en
  // premier pour obtenir rapidement les cas usuels. Le parcours reste borné.
  const dossiersTrouves = (
    await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "files(id,name)",
      pageSize: 30,
    })
  ).data.files?.flatMap((folder) =>
    folder.id ? [{ id: folder.id, nom: folder.name ?? "" }] : [],
  ) ?? [];
  const { morceaux, dossierIds: dossiers } = preparerRechercheDrive(
    nomRecherche,
    prenomRecherche,
    dossiersTrouves,
  );
  const clauseMime =
    mimeTypes && mimeTypes.length > 0
      ? ` and (${mimeTypes
          .map((mimeType) => `mimeType='${echapperRequeteDrive(mimeType)}'`)
          .join(" or ")})`
      : "";
  const resultats: FichierDriveTrouve[] = [];

  for (const parentId of dossiers) {
    if (resultats.length >= maximum) break;
    const files = await drive.files.list({
      q: `${morceaux.join(" and ")} and '${parentId}' in parents${clauseMime} and trashed=false`,
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "files(id,name,webViewLink)",
      pageSize: maximum - resultats.length,
    });
    for (const file of files.data.files ?? []) {
      if (!file.id || !file.name) continue;
      resultats.push({
        driveFileId: file.id,
        nomFichier: file.name,
        driveUrl:
          file.webViewLink ??
          `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
      });
    }
  }
  return resultats;
}

export async function verifierAppartenanceRacine(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  driveId: string,
  rootFolderId: string,
  codeErreur: string,
  messageErreur: string,
  maximumProfondeur = 5,
): Promise<drive_v3.Schema$File> {
  let courant = fileId;
  let fichierCible: drive_v3.Schema$File | null = null;
  for (let profondeur = 0; profondeur <= maximumProfondeur; profondeur++) {
    const response = await drive.files.get({
      fileId: courant,
      supportsAllDrives: true,
      fields: "id,name,mimeType,parents,trashed,webViewLink,driveId",
    });
    const file = response.data;
    if (!fichierCible) fichierCible = file;
    if (file.trashed || file.driveId !== driveId) {
      throw new ConvexError({ code: codeErreur, message: messageErreur });
    }
    if (courant === rootFolderId && fichierCible) return fichierCible;
    const parent = file.parents?.[0];
    if (!parent) break;
    courant = parent;
  }
  throw new ConvexError({ code: codeErreur, message: messageErreur });
}
