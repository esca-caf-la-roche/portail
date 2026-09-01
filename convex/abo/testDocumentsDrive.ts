"use node";

// I/O Google Drive de l'archive des tests : cette action ne touche jamais ctx.db.

import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "../customFunctions";
import { internal } from "../_generated/api";
import { Readable } from "node:stream";
import {
  configurationDrive,
  dossierInitiale,
  echapperRequeteDrive,
  initialeNom,
  prenomTitre,
  rechercherFichiersDrive,
  verifierAccesRacine,
} from "./driveArchives";

const MAX_LONGUEUR_NOM = 100;

export const envoyerVersDrive = authenticatedAction({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), uploadToken: v.string(), storageId: v.id("_storage") },
  returns: v.object({
    archiveId: v.id("abo_tests_autonomie_archive"),
    driveUrl: v.string(),
    statut: v.literal("a_traiter"),
  }),
  handler: async (ctx, args): Promise<{
    archiveId: typeof args.archiveId;
    driveUrl: string;
    statut: "a_traiter";
  }> => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "abonnements",
    });
    const claim = await ctx.runMutation(internal.abo.testDocuments.claimUploadInterne, {
      archiveId: args.archiveId, authorId: ctx.userId,
      uploadToken: args.uploadToken, storageId: args.storageId,
    });
    if (claim.statut === "drive_depose") {
      const result = await ctx.runMutation(internal.abo.testDocuments.finaliserUploadInterne, {
        archiveId: args.archiveId, authorId: ctx.userId,
        uploadToken: args.uploadToken, storageId: args.storageId,
      });
      await ctx.storage.delete(args.storageId);
      return result;
    }
    const contexte = await ctx.runQuery(internal.abo.testDocuments.contexteUploadInterne, {
      archiveId: args.archiveId,
      storageId: args.storageId,
    });
    try {
    if (!contexte.storageExists) {
      throw new ConvexError({ code: "TEST_FICHIER_INTRouvable", message: "Le fichier temporaire est introuvable." });
    }
    const typesAutorises = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]);
    if (
      !contexte.storageContentType ||
      !typesAutorises.has(contexte.storageContentType) ||
      !contexte.storageSize ||
      contexte.storageSize > 10 * 1024 * 1024
    ) {
      throw new ConvexError({
        code: "TEST_FICHIER_INVALIDE",
        message: "Le fichier doit être un PDF, JPEG ou PNG de 10 Mo maximum.",
      });
    }
    const sourceUrl = await ctx.storage.getUrl(args.storageId);
    if (!sourceUrl) {
      throw new ConvexError({ code: "TEST_FICHIER_INTRouvable", message: "Le fichier temporaire est introuvable." });
    }
    const source = await fetch(sourceUrl);
    if (!source.ok) {
      throw new ConvexError({ code: "TEST_FICHIER_LECTURE", message: "Impossible de lire le fichier temporaire." });
    }

    const { drive, driveId, rootFolderId } = configurationDrive({
      driveId: process.env.ABO_REGLEMENTS_DRIVE_ID,
      rootFolderId: process.env.ABO_TESTS_DRIVE_ROOT_FOLDER_ID,
      scope: "ecriture",
      messageConfiguration:
        "Les variables Google Drive de l'archive des tests ne sont pas configurées.",
    });
    await verifierAccesRacine(
      drive,
      rootFolderId,
      "Le compte de service Convex n'a pas accès au dossier Test d'autonomie. Partagez ce dossier avec esca-compta@esca-compta.iam.gserviceaccount.com.",
    );
    const parentId = await dossierInitiale(drive, driveId, rootFolderId, initialeNom(contexte.nom));
    if (!parentId) {
      throw new ConvexError({ code: "DRIVE_DOSSIER", message: "Impossible de déterminer le dossier Drive du candidat." });
    }
    const nomFichier = `${contexte.nom.trim().toLocaleUpperCase("fr-FR")} ${prenomTitre(contexte.prenom)}`;
    const bytes = Buffer.from(await source.arrayBuffer());
    const estPdf = bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    const estJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const estPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!estPdf && !estJpeg && !estPng) throw new ConvexError({ code: "TEST_FICHIER_INVALIDE", message: "Le contenu du fichier n'est pas un PDF, JPEG ou PNG valide." });
    // Une reprise après une réponse interrompue ne doit jamais créer un second
    // fichier homonyme : on rattache l'unique fichier déjà présent, sinon on crée.
    const dejaPresent = await drive.files.list({
      q: `name='${echapperRequeteDrive(nomFichier)}' and '${parentId}' in parents and trashed=false`,
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "files(id,webViewLink)",
    });
    const fichiers = dejaPresent.data.files ?? [];
    if (fichiers.length > 1) {
      throw new ConvexError({ code: "DRIVE_DOUBLON", message: "Plusieurs tests historiques portent ce nom dans Drive ; vérifiez le dossier avant de réessayer." });
    }
    const response = fichiers.length === 1
      ? null
      : await drive.files.create({
          requestBody: { name: nomFichier, parents: [parentId] },
          media: {
            mimeType: source.headers.get("content-type") ?? "application/pdf",
            // googleapis transmet le contenu multimédia via un flux Node ; un
            // Buffer n'implémente pas `.pipe()`, ce qui faisait échouer l'import.
            body: Readable.from(bytes),
          },
          supportsAllDrives: true,
          fields: "id, webViewLink",
        });
    const driveFileId = response?.data.id ?? fichiers[0]?.id;
    if (!driveFileId) {
      throw new ConvexError({ code: "DRIVE_UPLOAD", message: "Google Drive n'a pas confirmé le dépôt du fichier." });
    }
    const driveUrl = response?.data.webViewLink ?? fichiers[0]?.webViewLink ?? `https://drive.google.com/open?id=${driveFileId}`;
    await ctx.runMutation(internal.abo.testDocuments.marquerDriveDeposeInterne, { archiveId: args.archiveId, authorId: ctx.userId, uploadToken: args.uploadToken, storageId: args.storageId, driveFileId, driveUrl });
    const result = await ctx.runMutation(internal.abo.testDocuments.finaliserUploadInterne, { archiveId: args.archiveId, authorId: ctx.userId, uploadToken: args.uploadToken, storageId: args.storageId });
    await ctx.storage.delete(args.storageId);
    return result;
    } catch (error) {
      await ctx.runMutation(internal.abo.testDocuments.libererUploadInterne, { archiveId: args.archiveId, authorId: ctx.userId, uploadToken: args.uploadToken, storageId: args.storageId });
      await ctx.storage.delete(args.storageId);
      throw error;
    }
  },
});

// Recherche explicite d'un fichier n8n historique, par fragments de nom et/ou
// prénom. Une recherche avec un nom cible son dossier d'initiale ; un prénom
// seul parcourt au plus les 30 dossiers d'initiale de la racine Drive.
export const rechercherDansDrive = authenticatedAction({
  args: { nom: v.string(), prenom: v.string() },
  returns: v.array(v.object({ nomFichier: v.string(), driveUrl: v.string() })),
  handler: async (ctx, args): Promise<Array<{ nomFichier: string; driveUrl: string }>> => {
    await ctx.runQuery(internal.access.requireTileAccess, { userId: ctx.userId, tile: "abonnements" });
    const nom = args.nom.trim();
    const prenom = args.prenom.trim();
    if (!nom && !prenom) return [];
    if (nom.length > MAX_LONGUEUR_NOM || prenom.length > MAX_LONGUEUR_NOM) {
      throw new ConvexError({
        code: "TEST_RECHERCHE_INVALIDE",
        message: "Le nom et le prénom doivent contenir au maximum 100 caractères.",
      });
    }
    const { drive, driveId, rootFolderId } = configurationDrive({
      driveId: process.env.ABO_REGLEMENTS_DRIVE_ID,
      rootFolderId: process.env.ABO_TESTS_DRIVE_ROOT_FOLDER_ID,
      scope: "lecture",
      messageConfiguration:
        "Les variables Google Drive de l'archive des tests ne sont pas configurées.",
    });
    await verifierAccesRacine(
      drive,
      rootFolderId,
      "Le compte de service Convex n'a pas accès au dossier Test d'autonomie. Partagez ce dossier avec esca-compta@esca-compta.iam.gserviceaccount.com.",
    );
    // THROTTLE-OK: action manuelle staff, au plus 30 dossiers d'initiale et 20 fichiers.
    return (await rechercherFichiersDrive({
      drive,
      driveId,
      rootFolderId,
      nom,
      prenom,
    })).map(({ nomFichier, driveUrl }) => ({ nomFichier, driveUrl }));
  },
});
