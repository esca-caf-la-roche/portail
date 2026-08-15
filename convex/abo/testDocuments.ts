// Archive administrative des justificatifs de tests d'autonomie.
// Les comptes publics n'ont jamais accès à cette surface : chaque endpoint
// client est limité aux administrateurs Abonnements.

import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireAboAdmin } from "./auth";

const statutValidator = v.union(v.literal("a_traiter"), v.literal("traite"));
const uploadStatutValidator = v.union(
  v.literal("autorise"),
  v.literal("en_cours"),
  v.literal("drive_depose"),
);
const filtreValidator = v.union(
  v.literal("a_traiter"),
  v.literal("traite"),
  v.literal("tous"),
);

const archiveValidator = v.object({
  id: v.id("abo_tests_autonomie_archive"),
  licence: v.string(),
  nom: v.string(),
  prenom: v.string(),
  statut: statutValidator,
  driveUrl: v.string(),
  createdAt: v.number(),
});

const candidatValidator = v.object({
  personneId: v.union(v.id("abo_personnes"), v.null()),
  licence: v.string(),
  nom: v.string(),
  prenom: v.string(),
  licenceManquante: v.boolean(),
  reservationPassee: v.boolean(),
  archiveId: v.union(v.id("abo_tests_autonomie_archive"), v.null()),
  statut: v.union(statutValidator, v.null()),
  driveUrl: v.union(v.string(), v.null()),
});

function vueArchive(archive: {
  _id: Id<"abo_tests_autonomie_archive">;
  _creationTime: number;
  licence: string;
  nom: string;
  prenom: string;
  statut: "a_traiter" | "traite";
  drive_url: string;
}) {
  return {
    id: archive._id,
    licence: archive.licence,
    nom: archive.nom,
    prenom: archive.prenom,
    statut: archive.statut,
    driveUrl: archive.drive_url,
    createdAt: archive._creationTime,
  };
}

async function reservationPasseePourPersonne(
  ctx: Parameters<typeof requireAboAdmin>[0],
  personneId: Id<"abo_personnes">,
  avant: string,
): Promise<boolean> {
  const reservations = await ctx.db
    .query("abo_test_reservations")
    .withIndex("by_personne", (q) => q.eq("personne_id", personneId))
    .take(20);
  return reservations.some(
    (reservation) =>
      reservation.statut === "active" && reservation.tranche <= avant,
  );
}

// Liste bornée, destinée aux trois sous-onglets de traitement.
export const listArchives = authenticatedQuery({
  args: { filtre: filtreValidator },
  returns: v.array(archiveValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    if (args.filtre === "tous") {
      const archives = await ctx.db
        .query("abo_tests_autonomie_archive")
        .order("desc")
        .take(100);
      return archives.filter((archive) => archive.drive_file_id && archive.drive_url).map(vueArchive);
    }
    const statut = args.filtre as "a_traiter" | "traite";
    const archives = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_statut", (q) => q.eq("statut", statut))
      .order("desc")
      .take(100);
    return archives.filter((archive) => archive.drive_file_id && archive.drive_url).map(vueArchive);
  },
});

// Recherche strictement exacte : aucune consultation d'annuaire ni de nom.
export const rechercherCandidatParLicence = authenticatedQuery({
  args: { licence: v.string(), avant: v.string() },
  returns: v.union(candidatValidator, v.null()),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const licence = args.licence.trim();
    if (!licence) return null;

    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .take(2);
    if (personnes.length > 1) return null;
    const archive = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (personnes.length === 0) {
      const entreeAnnuaire = await ctx.db
        .query("abo_licences")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .unique();
      if (!entreeAnnuaire?.nom || !entreeAnnuaire.prenom) {
        if (!archive) return null;
        return {
          personneId: null,
          licence,
          nom: archive.nom,
          prenom: archive.prenom,
          licenceManquante: false,
          reservationPassee: false,
          archiveId: archive._id,
          statut: archive.statut,
          driveUrl: archive.drive_url || null,
        };
      }
      return {
        personneId: null,
        licence,
        nom: entreeAnnuaire.nom,
        prenom: entreeAnnuaire.prenom,
        licenceManquante: false,
        reservationPassee: false,
        archiveId: archive?._id ?? null,
        statut: archive?.statut ?? null,
        driveUrl: archive?.drive_url || null,
      };
    }
    const personne = personnes[0];
    return {
      personneId: personne._id,
      licence,
      nom: personne.nom,
      prenom: personne.prenom,
      licenceManquante: false,
      reservationPassee: await reservationPasseePourPersonne(
        ctx,
        personne._id,
        args.avant,
      ),
      archiveId: archive?._id ?? null,
      statut: archive?.statut ?? null,
      driveUrl: archive?.drive_url || null,
    };
  },
});

// Réservations passées : les entrées déjà archivées restent proposées afin de
// pouvoir remplacer le document. La borne prévient toute énumération massive.
export const listeReservationsPassees = authenticatedQuery({
  args: { avant: v.string() },
  returns: v.array(candidatValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const reservations = await ctx.db
      .query("abo_test_reservations")
      .withIndex("by_tranche", (q) => q.lte("tranche", args.avant))
      .order("desc")
      .take(100);
    const candidats = [] as Array<{
      personneId: Id<"abo_personnes"> | null;
      licence: string;
      nom: string;
      prenom: string;
      licenceManquante: boolean;
      reservationPassee: boolean;
      archiveId: Id<"abo_tests_autonomie_archive"> | null;
      statut: "a_traiter" | "traite" | null;
      driveUrl: string | null;
    }>;
    const vus = new Set<string>();

    for (const reservation of reservations) {
      if (reservation.statut !== "active") continue;
      if (!reservation.personne_id) {
        const licence = reservation.candidat_licence?.trim() ?? "";
        if (!licence || !reservation.candidat_nom || !reservation.candidat_prenom || vus.has(licence)) continue;
        vus.add(licence);
        const archive = await ctx.db
          .query("abo_tests_autonomie_archive")
          .withIndex("by_licence", (q) => q.eq("licence", licence))
          .unique();
        candidats.push({
          personneId: null,
          licence,
          nom: reservation.candidat_nom,
          prenom: reservation.candidat_prenom,
          licenceManquante: false,
          reservationPassee: true,
          archiveId: archive?._id ?? null,
          statut: archive?.statut ?? null,
          driveUrl: archive?.drive_url || null,
        });
        continue;
      }
      const personne = await ctx.db.get(reservation.personne_id);
      if (!personne || vus.has(personne._id)) continue;
      vus.add(personne._id);
      const licence = personne.licence?.trim() ?? "";
      const archive = licence
        ? await ctx.db
            .query("abo_tests_autonomie_archive")
            .withIndex("by_licence", (q) => q.eq("licence", licence))
            .unique()
        : null;
      candidats.push({
        personneId: personne._id,
        licence,
        nom: personne.nom,
        prenom: personne.prenom,
        licenceManquante: !licence,
        reservationPassee: true,
        archiveId: archive?._id ?? null,
        statut: archive?.statut ?? null,
        driveUrl: archive?.drive_url || null,
      });
    }
    return candidats;
  },
});

// Crée (ou retrouve) le point d'ancrage d'une archive avant l'envoi du fichier.
export const preparerDepot = authenticatedMutation({
  args: { licence: v.string() },
  returns: v.object({
    archiveId: v.id("abo_tests_autonomie_archive"),
    licence: v.string(),
    nom: v.string(),
    prenom: v.string(),
    statut: statutValidator,
    uploadToken: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const licence = args.licence.trim();
    if (!licence) {
      throw new ConvexError({
        code: "TEST_LICENCE_REQUISE",
        message: "Une licence est requise pour archiver le test.",
      });
    }
    const dejaArchive = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (dejaArchive) {
      if (dejaArchive.drive_file_id && dejaArchive.drive_url) {
        throw new ConvexError({
          code: "TEST_DEJA_ARCHIVE",
          message: "Un document est déjà archivé pour cette licence et ne peut pas être remplacé.",
        });
      }
    }
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .take(2);
    if (personnes.length > 1) {
      throw new ConvexError({
        code: "TEST_LICENCE_AMBIGUE",
        message: "Cette licence correspond à plusieurs dossiers et ne peut pas être archivée automatiquement.",
      });
    }
    const personne = personnes[0] ?? null;
    const entreeAnnuaire = personne
      ? null
      : await ctx.db
          .query("abo_licences")
          .withIndex("by_licence", (q) => q.eq("licence", licence))
          .unique();
    const nom = personne?.nom ?? entreeAnnuaire?.nom;
    const prenom = personne?.prenom ?? entreeAnnuaire?.prenom;
    const nomPrenomNormalise = personne?.nom_prenom_normalise ?? entreeAnnuaire?.nom_prenom_normalise;
    if (!nom || !prenom || !nomPrenomNormalise) {
      throw new ConvexError({
        code: "TEST_LICENCE_INCONNUE",
        message: "Cette licence ne permet pas d'identifier précisément le candidat.",
      });
    }
    const archiveId = dejaArchive
      ? dejaArchive._id
      : await ctx.db.insert("abo_tests_autonomie_archive", {
        licence, nom, prenom, nom_prenom_normalise: nomPrenomNormalise,
        drive_file_id: "", drive_url: "", statut: "a_traiter",
      });
    const uploadToken = crypto.randomUUID();
    const ticket = await ctx.db
      .query("abo_test_document_uploads")
      .withIndex("by_archive", (q) => q.eq("archive_id", archiveId))
      .unique();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    if (ticket && ticket.expires_at > Date.now()) {
      throw new ConvexError({
        code: "TEST_DEPOT_EN_COURS",
        message: "Un dépôt est déjà en cours pour cette licence.",
      });
    }
    if (ticket) {
      await ctx.db.patch(ticket._id, {
        author_id: ctx.userId, token: uploadToken, statut: "autorise",
        storage_id: undefined, drive_file_id: undefined, drive_url: undefined,
        expires_at: expiresAt, claimed_at: undefined,
      });
    } else {
      await ctx.db.insert("abo_test_document_uploads", {
        archive_id: archiveId, author_id: ctx.userId, token: uploadToken,
        statut: "autorise", expires_at: expiresAt,
      });
    }
    return {
      archiveId,
      licence,
      nom,
      prenom,
      statut: "a_traiter" as const,
      uploadToken,
    };
  },
});

export const genererUrlUpload = authenticatedMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), uploadToken: v.string() },
  returns: v.object({ uploadUrl: v.string() }),
  handler: async (ctx, args): Promise<{ uploadUrl: string }> => {
    await requireAboAdmin(ctx);
    const ticket = await ctx.db.query("abo_test_document_uploads")
      .withIndex("by_archive", (q) => q.eq("archive_id", args.archiveId)).unique();
    if (!ticket || ticket.author_id !== ctx.userId || ticket.token !== args.uploadToken || ticket.statut !== "autorise" || ticket.expires_at <= Date.now()) {
      throw new ConvexError({ code: "TEST_ARCHIVE_INTRouvable", message: "Archive introuvable." });
    }
    return { uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const claimUploadInterne = internalMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), authorId: v.id("users"), uploadToken: v.string(), storageId: v.id("_storage") },
  returns: v.object({ statut: uploadStatutValidator, driveFileId: v.union(v.string(), v.null()), driveUrl: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.query("abo_test_document_uploads").withIndex("by_archive", (q) => q.eq("archive_id", args.archiveId)).unique();
    if (!ticket || ticket.author_id !== args.authorId || ticket.token !== args.uploadToken || ticket.expires_at <= Date.now()) {
      throw new ConvexError({ code: "TEST_UPLOAD_NON_AUTORISE", message: "Ce dépôt n'est plus autorisé." });
    }
    if (ticket.statut === "drive_depose") return { statut: ticket.statut, driveFileId: ticket.drive_file_id ?? null, driveUrl: ticket.drive_url ?? null };
    if (ticket.statut === "en_cours") throw new ConvexError({ code: "TEST_UPLOAD_EN_COURS", message: "Le dépôt est déjà en cours." });
    await ctx.db.patch(ticket._id, { statut: "en_cours", storage_id: args.storageId, claimed_at: Date.now() });
    return { statut: "en_cours" as const, driveFileId: null, driveUrl: null };
  },
});

export const marquerDriveDeposeInterne = internalMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), authorId: v.id("users"), uploadToken: v.string(), storageId: v.id("_storage"), driveFileId: v.string(), driveUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.query("abo_test_document_uploads").withIndex("by_archive", (q) => q.eq("archive_id", args.archiveId)).unique();
    if (!ticket || ticket.author_id !== args.authorId || ticket.token !== args.uploadToken || ticket.statut !== "en_cours" || ticket.storage_id !== args.storageId) throw new ConvexError({ code: "TEST_UPLOAD_NON_AUTORISE", message: "Ce dépôt n'est plus autorisé." });
    await ctx.db.patch(ticket._id, { statut: "drive_depose", drive_file_id: args.driveFileId, drive_url: args.driveUrl });
    return null;
  },
});

export const finaliserUploadInterne = internalMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), authorId: v.id("users"), uploadToken: v.string(), storageId: v.id("_storage") },
  returns: v.object({ archiveId: v.id("abo_tests_autonomie_archive"), driveUrl: v.string(), statut: v.literal("a_traiter") }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.query("abo_test_document_uploads").withIndex("by_archive", (q) => q.eq("archive_id", args.archiveId)).unique();
    if (!ticket || ticket.author_id !== args.authorId || ticket.token !== args.uploadToken || ticket.storage_id !== args.storageId || ticket.statut !== "drive_depose" || !ticket.drive_file_id || !ticket.drive_url) throw new ConvexError({ code: "TEST_UPLOAD_NON_AUTORISE", message: "Ce dépôt n'est plus autorisé." });
    const archive = await ctx.db.get(args.archiveId);
    if (!archive || archive.drive_file_id || archive.drive_url) throw new ConvexError({ code: "TEST_DEJA_ARCHIVE", message: "Un document est déjà archivé pour cette licence." });
    await ctx.db.patch(args.archiveId, { drive_file_id: ticket.drive_file_id, drive_url: ticket.drive_url, statut: "a_traiter" });
    await ctx.db.delete(ticket._id);
    return { archiveId: args.archiveId, driveUrl: ticket.drive_url, statut: "a_traiter" as const };
  },
});

export const libererUploadInterne = internalMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), authorId: v.id("users"), uploadToken: v.string(), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.query("abo_test_document_uploads").withIndex("by_archive", (q) => q.eq("archive_id", args.archiveId)).unique();
    if (ticket?.author_id === args.authorId && ticket.token === args.uploadToken && ticket.statut === "en_cours" && ticket.storage_id === args.storageId) await ctx.db.patch(ticket._id, { statut: "autorise", storage_id: undefined, claimed_at: undefined });
    return null;
  },
});

export const marquerTraite = authenticatedMutation({
  args: { archiveId: v.id("abo_tests_autonomie_archive") },
  returns: v.object({
    archiveId: v.id("abo_tests_autonomie_archive"),
    statut: v.literal("traite"),
  }),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const archive = await ctx.db.get(args.archiveId);
    if (!archive || !archive.drive_file_id || !archive.drive_url) {
      throw new ConvexError({ code: "TEST_ARCHIVE_INTRouvable", message: "Archive introuvable." });
    }
    if (archive.statut !== "traite") {
      await ctx.db.patch(args.archiveId, { statut: "traite" });
    }
    return { archiveId: args.archiveId, statut: "traite" as const };
  },
});

// Lecture privée demandée par l'action Node après sa garde de tuile.
export const contexteUploadInterne = internalQuery({
  args: { archiveId: v.id("abo_tests_autonomie_archive"), storageId: v.id("_storage") },
  returns: v.object({
    archiveId: v.id("abo_tests_autonomie_archive"),
    licence: v.string(),
    nom: v.string(),
    prenom: v.string(),
    driveFileId: v.string(),
    storageExists: v.boolean(),
    storageContentType: v.union(v.string(), v.null()),
    storageSize: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const archive = await ctx.db.get(args.archiveId);
    if (!archive) {
      throw new ConvexError({ code: "TEST_ARCHIVE_INTRouvable", message: "Archive introuvable." });
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    return {
      archiveId: archive._id,
      licence: archive.licence,
      nom: archive.nom,
      prenom: archive.prenom,
      driveFileId: archive.drive_file_id,
      storageExists: metadata !== null,
      storageContentType: metadata?.contentType ?? null,
      storageSize: metadata?.size ?? null,
    };
  },
});

// Résolution exacte et privée pour la recherche ponctuelle des archives n8n.
export const contexteRechercheHistorique = internalQuery({
  args: { licence: v.string() },
  returns: v.union(
    v.object({ licence: v.string(), nom: v.string(), prenom: v.string(), nomPrenomNormalise: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const licence = args.licence.trim();
    if (!licence) return null;
    const archive = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (archive) {
      throw new ConvexError({ code: "TEST_DEJA_ARCHIVE", message: "Un document est déjà archivé pour cette licence." });
    }
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .take(2);
    if (personnes.length > 1) return null;
    if (personnes.length === 1) {
      const personne = personnes[0];
      return { licence, nom: personne.nom, prenom: personne.prenom, nomPrenomNormalise: personne.nom_prenom_normalise };
    }
    const annuaire = await ctx.db
      .query("abo_licences")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (!annuaire?.nom || !annuaire.prenom) return null;
    return { licence, nom: annuaire.nom, prenom: annuaire.prenom, nomPrenomNormalise: annuaire.nom_prenom_normalise };
  },
});

export const creerArchiveHistoriqueInterne = internalMutation({
  args: { licence: v.string(), nom: v.string(), prenom: v.string(), nomPrenomNormalise: v.string() },
  returns: v.id("abo_tests_autonomie_archive"),
  handler: async (ctx, args) => {
    const existante = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_licence", (q) => q.eq("licence", args.licence))
      .unique();
    if (existante) {
      throw new ConvexError({ code: "TEST_DEJA_ARCHIVE", message: "Un document est déjà archivé pour cette licence." });
    }
    return await ctx.db.insert("abo_tests_autonomie_archive", {
      licence: args.licence, nom: args.nom, prenom: args.prenom,
      nom_prenom_normalise: args.nomPrenomNormalise,
      drive_file_id: "", drive_url: "", statut: "a_traiter",
    });
  },
});

export const persisterUploadDrive = internalMutation({
  args: {
    archiveId: v.id("abo_tests_autonomie_archive"),
    driveFileId: v.string(),
    driveUrl: v.string(),
  },
  returns: v.object({
    archiveId: v.id("abo_tests_autonomie_archive"),
    driveUrl: v.string(),
    statut: v.literal("a_traiter"),
  }),
  handler: async (ctx, args) => {
    const archive = await ctx.db.get(args.archiveId);
    if (!archive) {
      throw new ConvexError({ code: "TEST_ARCHIVE_INTRouvable", message: "Archive introuvable." });
    }
    if (
      archive.drive_file_id !== args.driveFileId ||
      archive.drive_url !== args.driveUrl ||
      archive.statut !== "a_traiter"
    ) {
      await ctx.db.patch(args.archiveId, {
        drive_file_id: args.driveFileId,
        drive_url: args.driveUrl,
        statut: "a_traiter",
      });
    }
    return {
      archiveId: args.archiveId,
      driveUrl: args.driveUrl,
      statut: "a_traiter" as const,
    };
  },
});
