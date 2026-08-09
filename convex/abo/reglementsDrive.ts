"use node";

// Accès manuel au dossier Drive des règlements. Aucune URL fournie par le
// client n'est utilisée : le serveur construit le lien depuis l'id vérifié.

import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "../customFunctions";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { REGLEMENT_VERSION } from "./reglementsConstants";
import {
  configurationDrive,
  rechercherFichiersDrive,
  verifierAccesRacine,
  verifierAppartenanceRacine,
} from "./driveArchives";

const MIME_PDF = "application/pdf";
const MAX_FICHIERS_DRIVE = 20;
const MAX_LONGUEUR_NOM = 100;

const resultatDriveValidator = v.object({
  driveFileId: v.string(),
  driveUrl: v.string(),
  nomFichier: v.string(),
});

export const rechercherDansDrive = authenticatedAction({
  args: { nom: v.string(), prenom: v.string() },
  returns: v.array(resultatDriveValidator),
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "abonnements",
    });
    const nom = args.nom.trim();
    const prenom = args.prenom.trim();
    if (!nom && !prenom) return [];
    if (nom.length > MAX_LONGUEUR_NOM || prenom.length > MAX_LONGUEUR_NOM) {
      throw new ConvexError({
        code: "REGLEMENT_RECHERCHE_INVALIDE",
        message: "Le nom et le prénom doivent contenir au maximum 100 caractères.",
      });
    }

    const { drive, driveId, rootFolderId } = configurationDrive({
      driveId: process.env.ABO_REGLEMENTS_DRIVE_ID,
      rootFolderId: process.env.ABO_REGLEMENTS_DRIVE_ROOT_FOLDER_ID,
      scope: "lecture",
      messageConfiguration:
        "Les variables Google Drive des règlements ne sont pas configurées.",
    });
    await verifierAccesRacine(
      drive,
      rootFolderId,
      "Le compte de service Convex n'a pas accès au dossier des règlements. Partagez ce dossier avec esca-compta@esca-compta.iam.gserviceaccount.com.",
    );
    // THROTTLE-OK: action manuelle staff, au plus 30 dossiers d'initiale et 20 PDF.
    return await rechercherFichiersDrive({
      drive,
      driveId,
      rootFolderId,
      nom,
      prenom,
      mimeTypes: [MIME_PDF],
      maximum: MAX_FICHIERS_DRIVE,
    });
  },
});

export const lierFichierALicence = authenticatedAction({
  args: { driveFileId: v.string(), licence: v.string() },
  returns: v.object({
    id: v.id("abo_reglements_signes"),
    driveFileId: v.string(),
    driveUrl: v.string(),
    nomFichier: v.string(),
    nom: v.string(),
    prenom: v.string(),
    licence: v.string(),
    statut: v.union(v.literal("a_enregistrer"), v.literal("enregistre")),
  }),
  handler: async (ctx, args): Promise<{
    id: Id<"abo_reglements_signes">;
    driveFileId: string;
    driveUrl: string;
    nomFichier: string;
    nom: string;
    prenom: string;
    licence: string;
    statut: "a_enregistrer" | "enregistre";
  }> => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "abonnements",
    });
    const driveFileId = args.driveFileId.trim();
    if (!driveFileId || driveFileId.length > 200) {
      throw new ConvexError({
        code: "REGLEMENT_DRIVE_ID_INVALIDE",
        message: "L'identifiant du fichier Drive est invalide.",
      });
    }
    const { drive, driveId, rootFolderId } = configurationDrive({
      driveId: process.env.ABO_REGLEMENTS_DRIVE_ID,
      rootFolderId: process.env.ABO_REGLEMENTS_DRIVE_ROOT_FOLDER_ID,
      scope: "lecture",
      messageConfiguration:
        "Les variables Google Drive des règlements ne sont pas configurées.",
    });
    const file = await verifierAppartenanceRacine(
      drive,
      driveFileId,
      driveId,
      rootFolderId,
      "REGLEMENT_DRIVE_HORS_RACINE",
      "Ce fichier n'appartient pas au dossier Drive autorisé.",
    );
    if (file.mimeType !== MIME_PDF) {
      throw new ConvexError({
        code: "REGLEMENT_DRIVE_FORMAT",
        message: "Le règlement sélectionné doit être un fichier PDF.",
      });
    }
    const driveUrl =
      file.webViewLink ??
      `https://drive.google.com/open?id=${encodeURIComponent(driveFileId)}`;
    return await ctx.runMutation(internal.abo.reglements.lierReglementInterne, {
      userId: ctx.userId,
      licence: args.licence,
      driveFileId,
      driveFileName: file.name ?? "reglement.pdf",
      driveUrl,
      versionReglement: REGLEMENT_VERSION,
    });
  },
});

// Liaison d'un import n8n : l'id Drive reçu par le webhook n'est jamais
// considéré comme une preuve. Le serveur recharge le fichier et vérifie son
// Shared Drive, son ascendance et son MIME avant toute écriture métier.
export const lierImportALicence = authenticatedAction({
  args: { importId: v.id("abo_reglements_imports"), licence: v.string() },
  returns: v.object({
    id: v.id("abo_reglements_signes"),
    driveFileId: v.string(),
    driveUrl: v.string(),
    nomFichier: v.string(),
    nom: v.string(),
    prenom: v.string(),
    licence: v.string(),
    statut: v.union(v.literal("a_enregistrer"), v.literal("enregistre")),
  }),
  handler: async (ctx, args): Promise<{
    id: Id<"abo_reglements_signes">;
    driveFileId: string;
    driveUrl: string;
    nomFichier: string;
    nom: string;
    prenom: string;
    licence: string;
    statut: "a_enregistrer" | "enregistre";
  }> => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "abonnements",
    });
    const contexte = await ctx.runQuery(
      internal.abo.reglementsImports.contexteLiaisonDrive,
      args,
    );
    if (contexte.kind === "deja_lie") return contexte.reglement;

    const driveFileId = contexte.driveFileId.trim();
    if (!driveFileId || driveFileId.length > 200) {
      throw new ConvexError({
        code: "REGLEMENT_DRIVE_ID_INVALIDE",
        message: "L'identifiant du fichier Drive est invalide.",
      });
    }
    const { drive, driveId, rootFolderId } = configurationDrive({
      driveId: process.env.ABO_REGLEMENTS_DRIVE_ID,
      rootFolderId: process.env.ABO_REGLEMENTS_DRIVE_ROOT_FOLDER_ID,
      scope: "lecture",
      messageConfiguration:
        "Les variables Google Drive des règlements ne sont pas configurées.",
    });
    const file = await verifierAppartenanceRacine(
      drive,
      driveFileId,
      driveId,
      rootFolderId,
      "REGLEMENT_DRIVE_HORS_RACINE",
      "Ce fichier n'appartient pas au dossier Drive autorisé.",
    );
    if (file.mimeType !== MIME_PDF) {
      throw new ConvexError({
        code: "REGLEMENT_DRIVE_FORMAT",
        message: "Le règlement sélectionné doit être un fichier PDF.",
      });
    }
    const driveFileName = file.name?.trim();
    if (!driveFileName) {
      throw new ConvexError({
        code: "REGLEMENT_DRIVE_NOM_ABSENT",
        message: "Le fichier Drive vérifié n'a pas de nom exploitable.",
      });
    }
    const driveUrl =
      file.webViewLink ??
      `https://drive.google.com/open?id=${encodeURIComponent(driveFileId)}`;
    return await ctx.runMutation(
      internal.abo.reglementsImports.finaliserLiaisonDrive,
      {
        importId: args.importId,
        userId: ctx.userId,
        licence: args.licence,
        driveFileId,
        driveFileName,
        driveUrl,
        versionReglement: contexte.versionReglement,
      },
    );
  },
});
