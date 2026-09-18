// Archive administrative des justificatifs de tests d'autonomie.
// Les comptes publics n'ont jamais accès à cette surface : chaque endpoint
// client est limité aux administrateurs Abonnements.

import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { champsModifies } from "../dbUtils";
import { requireAboAdmin } from "./auth";
import { canoniserLicence } from "./lib";

const DUREE_LEGACY_MS = 60 * 60 * 1000;
const MAX_RESERVATIONS_PAR_PERSONNE = 100;
const MAX_PERSONNES_PAR_LICENCE = 50;

function verifierBorne<T>(lignes: T[], maximum: number, libelle: string): T[] {
  if (lignes.length > maximum) {
    throw new ConvexError({
      code: "TEST_VOLUME_DEPASSE",
      message: `${libelle} dépasse la limite de sécurité (${maximum}). Contactez un administrateur.`,
    });
  }
  return lignes;
}

function cleCandidatPasse(
  licence: string,
  personneId?: Id<"abo_personnes">,
): string {
  const licenceCanonique = canoniserLicence(licence) ?? licence.trim().toUpperCase();
  return licenceCanonique ? `licence:${licenceCanonique}` : `personne:${personneId ?? "inconnue"}`;
}

function reservationEstPassee(
  reservation: { tranche: string; tranche_fin?: string },
  avant: string,
): boolean {
  const debut = Date.parse(reservation.tranche);
  const reference = Date.parse(avant);
  if (!Number.isFinite(debut) || !Number.isFinite(reference)) return false;
  const finLue = reservation.tranche_fin ? Date.parse(reservation.tranche_fin) : Number.NaN;
  const fin = Number.isFinite(finLue) && finLue > debut ? finLue : debut + DUREE_LEGACY_MS;
  return fin <= reference;
}

const statutValidator = v.union(v.literal("a_traiter"), v.literal("traite"));
const resultatTestValidator = v.union(
  v.literal("valide"),
  v.literal("non_valide"),
  v.literal("absent"),
);
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
  reservationId: v.union(v.id("abo_test_reservations"), v.null()),
  personneId: v.union(v.id("abo_personnes"), v.null()),
  licence: v.string(),
  nom: v.string(),
  prenom: v.string(),
  licenceManquante: v.boolean(),
  reservationPassee: v.boolean(),
  archiveId: v.union(v.id("abo_tests_autonomie_archive"), v.null()),
  statut: v.union(statutValidator, v.null()),
  driveUrl: v.union(v.string(), v.null()),
  resultatTest: v.union(resultatTestValidator, v.null()),
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

// Le site du club est la source de vérité du résultat d'autonomie. Une archive
// reste conservée dans Drive, mais n'a plus à être proposée au staff une fois
// que le snapshot confirme « OK » pour cette licence.
async function autonomieConfirmeeSurSite(
  ctx: Parameters<typeof requireAboAdmin>[0],
  licence: string,
): Promise<boolean> {
  const licenceCanonique = canoniserLicence(licence);
  if (!licenceCanonique) return false;
  const snapshot = await ctx.db
    .query("abo_abonnes_scrap")
    .withIndex("by_licence", (q) => q.eq("licence", licenceCanonique))
    .first();
  return snapshot?.autonomie === "OK";
}

async function archivesAffichables<T extends {
  licence: string;
  drive_file_id: string;
  drive_url: string;
}>(
  ctx: Parameters<typeof requireAboAdmin>[0],
  archives: T[],
): Promise<T[]> {
  const avecDocumentDrive = archives.filter(
    (archive) => archive.drive_file_id && archive.drive_url,
  );
  const licencesAutonomes = await Promise.all(
    [...new Set(avecDocumentDrive.map(
      (archive) => canoniserLicence(archive.licence) ?? archive.licence,
    ))].map(
      async (licence) => [licence, await autonomieConfirmeeSurSite(ctx, licence)] as const,
    ),
  );
  const autonomieParLicence = new Map(licencesAutonomes);
  return avecDocumentDrive.filter(
    (archive) => !autonomieParLicence.get(canoniserLicence(archive.licence) ?? archive.licence),
  );
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
      reservation.statut === "active" && reservationEstPassee(reservation, avant),
  );
}

async function aUneAutreReservationFuture(
  ctx: Parameters<typeof requireAboAdmin>[0],
  reservation: {
    _id: Id<"abo_test_reservations">;
    personne_id?: Id<"abo_personnes">;
    candidat_licence?: string;
  },
  maintenantIso: string,
): Promise<boolean> {
  const reservations = new Map<Id<"abo_test_reservations">, {
    _id: Id<"abo_test_reservations">;
    tranche: string;
    tranche_fin?: string;
    statut: "active" | "annulee";
  }>();
  let licence = reservation.candidat_licence?.trim() ?? "";
  if (reservation.personne_id) {
    const personne = await ctx.db.get(reservation.personne_id);
    licence = personne?.licence?.trim() ?? licence;
    const liees = verifierBorne(await ctx.db
      .query("abo_test_reservations")
      .withIndex("by_personne", (q) => q.eq("personne_id", reservation.personne_id))
      .take(MAX_RESERVATIONS_PAR_PERSONNE + 1), MAX_RESERVATIONS_PAR_PERSONNE, "Les réservations de cette personne");
    for (const ligne of liees) reservations.set(ligne._id, ligne);
  }
  if (licence) {
    const directes = verifierBorne(await ctx.db
      .query("abo_test_reservations")
      .withIndex("by_candidat_licence", (q) => q.eq("candidat_licence", licence))
      .take(MAX_RESERVATIONS_PAR_PERSONNE + 1), MAX_RESERVATIONS_PAR_PERSONNE, "Les réservations directes de cette licence");
    for (const ligne of directes) reservations.set(ligne._id, ligne);
    const personnes = verifierBorne(await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .take(MAX_PERSONNES_PAR_LICENCE + 1), MAX_PERSONNES_PAR_LICENCE, "Les personnes liées à cette licence");
    for (const personne of personnes) {
      const liees = verifierBorne(await ctx.db
        .query("abo_test_reservations")
        .withIndex("by_personne", (q) => q.eq("personne_id", personne._id))
        .take(MAX_RESERVATIONS_PAR_PERSONNE + 1), MAX_RESERVATIONS_PAR_PERSONNE, "Les réservations de cette personne");
      for (const ligne of liees) reservations.set(ligne._id, ligne);
    }
  }
  return [...reservations.values()].some((autre) =>
    autre._id !== reservation._id
    && autre.statut === "active"
    && !reservationEstPassee(autre, maintenantIso)
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
      return (await archivesAffichables(ctx, archives)).map(vueArchive);
    }
    const statut = args.filtre as "a_traiter" | "traite";
    const archives = await ctx.db
      .query("abo_tests_autonomie_archive")
      .withIndex("by_statut", (q) => q.eq("statut", statut))
      .order("desc")
      .take(100);
    return (await archivesAffichables(ctx, archives)).map(vueArchive);
  },
});

const MAX_CANDIDATS_RECHERCHE_LICENCE = 10;
const PREFIXE_LICENCE_CLUB = "7480";
const ANNEES_LICENCE_RECHERCHE = Array.from({ length: 36 }, (_, index) => 2000 + index);

// Une licence du club suit le format 7480 + année initiale + identifiant.
// La recherche accepte le numéro complet, les 6 derniers chiffres (année sur
// 2 chiffres + identifiant) ou les 4 derniers chiffres. Dans ce dernier cas,
// les années 2000 à 2035 sont testées par lectures exactes et bornées.
export const rechercherCandidatParLicence = authenticatedQuery({
  args: { licence: v.string(), avant: v.string() },
  returns: v.array(candidatValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const saisie = args.licence.replace(/\s/g, "");
    if (!/^\d+$/.test(saisie)) return [];
    const licencesRecherchees = saisie.length === 12
      ? [saisie]
      : saisie.length === 6
        ? [`${PREFIXE_LICENCE_CLUB}20${saisie}`]
        : saisie.length === 4
          ? ANNEES_LICENCE_RECHERCHE.map((annee) => `${PREFIXE_LICENCE_CLUB}${annee}${saisie}`)
          : [];
    if (licencesRecherchees.length === 0) return [];

    const [personnes, annuaire, archives] = await Promise.all([
      Promise.all(licencesRecherchees.map((licence) => ctx.db
        .query("abo_personnes")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .take(2))),
      Promise.all(licencesRecherchees.map((licence) => ctx.db
        .query("abo_licences")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .unique())),
      Promise.all(licencesRecherchees.map((licence) => ctx.db
        .query("abo_tests_autonomie_archive")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .order("desc")
        .first())),
    ]);
    const personnesTrouvees = personnes.flat();
    const entreesAnnuaire = annuaire.filter((entree) => entree !== null);
    const archivesTrouvees = archives.filter((archive) => archive !== null);

    const nombrePersonnesParLicence = new Map<string, number>();
    for (const personne of personnesTrouvees) {
      if (personne.licence) {
        nombrePersonnesParLicence.set(
          personne.licence,
          (nombrePersonnesParLicence.get(personne.licence) ?? 0) + 1,
        );
      }
    }
    const personnesParLicence = new Map(
      personnesTrouvees
        .filter((personne) => personne.licence && nombrePersonnesParLicence.get(personne.licence) === 1)
        .map((personne) => [personne.licence!, personne]),
    );
    const annuaireParLicence = new Map(entreesAnnuaire.map((entree) => [entree.licence, entree]));
    const archivesParLicence = new Map(archivesTrouvees.map((archive) => [archive.licence, archive]));
    const licences = [...new Set([
      ...personnesParLicence.keys(),
      ...annuaireParLicence.keys(),
      ...archivesParLicence.keys(),
    ])]
      .filter((licence) => (nombrePersonnesParLicence.get(licence) ?? 0) <= 1)
      .sort()
      .slice(0, MAX_CANDIDATS_RECHERCHE_LICENCE);

    return await Promise.all(licences.map(async (licence) => {
      const personne = personnesParLicence.get(licence) ?? null;
      const entreeAnnuaire = annuaireParLicence.get(licence);
      const archive = archivesParLicence.get(licence);
      return {
        reservationId: null,
        personneId: personne?._id ?? null,
        licence,
        nom: personne?.nom ?? entreeAnnuaire?.nom ?? archive?.nom ?? "",
        prenom: personne?.prenom ?? entreeAnnuaire?.prenom ?? archive?.prenom ?? "",
        licenceManquante: false,
        reservationPassee: personne
          ? await reservationPasseePourPersonne(ctx, personne._id, args.avant)
          : false,
        archiveId: archive?._id ?? null,
        statut: archive?.statut ?? null,
        driveUrl: archive?.drive_url || null,
        resultatTest: null,
      };
    }));
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
      reservationId: Id<"abo_test_reservations"> | null;
      personneId: Id<"abo_personnes"> | null;
      licence: string;
      nom: string;
      prenom: string;
      licenceManquante: boolean;
      reservationPassee: boolean;
      archiveId: Id<"abo_tests_autonomie_archive"> | null;
      statut: "a_traiter" | "traite" | null;
      driveUrl: string | null;
      resultatTest: "valide" | "non_valide" | "absent" | null;
    }>;
    const vus = new Set<string>();

    for (const reservation of reservations) {
      if (reservation.statut !== "active") continue;
      if (!reservationEstPassee(reservation, args.avant)) continue;
      if (!reservation.personne_id) {
        const licence = reservation.candidat_licence?.trim() ?? "";
        const cleCandidat = cleCandidatPasse(licence);
        if (!licence || !reservation.candidat_nom || !reservation.candidat_prenom || vus.has(cleCandidat)) continue;
        vus.add(cleCandidat);
        const archive = await ctx.db
          .query("abo_tests_autonomie_archive")
          .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation._id))
          .unique();
        candidats.push({
          reservationId: reservation._id,
          personneId: null,
          licence,
          nom: reservation.candidat_nom,
          prenom: reservation.candidat_prenom,
          licenceManquante: false,
          reservationPassee: true,
          archiveId: archive?._id ?? null,
          statut: archive?.statut ?? null,
          driveUrl: archive?.drive_url || null,
          resultatTest: reservation.resultat_test ?? null,
        });
        continue;
      }
      const personne = await ctx.db.get(reservation.personne_id);
      if (!personne) continue;
      const licence = personne.licence?.trim() ?? "";
      const cleCandidat = cleCandidatPasse(licence, personne._id);
      if (vus.has(cleCandidat)) continue;
      vus.add(cleCandidat);
      const archive = await ctx.db
        .query("abo_tests_autonomie_archive")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation._id))
        .unique();
      candidats.push({
        reservationId: reservation._id,
        personneId: personne._id,
        licence,
        nom: personne.nom,
        prenom: personne.prenom,
        licenceManquante: !licence,
        reservationPassee: true,
        archiveId: archive?._id ?? null,
        statut: archive?.statut ?? null,
        driveUrl: archive?.drive_url || null,
        resultatTest: reservation.resultat_test ?? null,
      });
    }
    return candidats;
  },
});

export const renseignerResultatTest = authenticatedMutation({
  args: {
    reservationId: v.id("abo_test_reservations"),
    resultat: resultatTestValidator,
  },
  returns: v.object({
    reservationId: v.id("abo_test_reservations"),
    resultat: resultatTestValidator,
  }),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || reservation.statut !== "active") {
      throw new ConvexError({
        code: "TEST_RESERVATION_INTROUVABLE",
        message: "Cette réservation de test est introuvable ou annulée.",
      });
    }
    if (!reservationEstPassee(reservation, new Date().toISOString())) {
      throw new ConvexError({
        code: "TEST_RESULTAT_TROP_TOT",
        message: "Le résultat ne peut être renseigné qu'après la fin du créneau.",
      });
    }
    const maintenantIso = new Date().toISOString();
    if (
      args.resultat === "valide"
      && reservation.resultat_test !== "valide"
      && await aUneAutreReservationFuture(ctx, reservation, maintenantIso)
    ) {
      throw new ConvexError({
        code: "TEST_RESERVATION_FUTURE_EXISTANTE",
        message: "Annulez d'abord le nouveau créneau avant de corriger cette tentative en test validé.",
      });
    }
    if (args.resultat !== "absent") {
      const archive = await ctx.db
        .query("abo_tests_autonomie_archive")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation._id))
        .unique();
      if (!archive?.drive_file_id || !archive.drive_url) {
        throw new ConvexError({
          code: "TEST_DOCUMENT_REQUIS",
          message: "Déposez le formulaire du test avant de l'indiquer comme validé ou non validé.",
        });
      }
      if (archive.resultat_test !== args.resultat) {
        throw new ConvexError({
          code: "TEST_RESULTAT_DOCUMENT_INCOHERENT",
          message: "Ce résultat ne peut pas être modifié car le nom du document Drive correspond au résultat déjà enregistré.",
        });
      }
    }
    if (reservation.resultat_test !== args.resultat) {
      const miseAJour = {
        resultat_test: args.resultat,
        resultat_renseigne_le: maintenantIso,
        resultat_renseigne_par: ctx.userId,
      };
      if (champsModifies(reservation, miseAJour)) {
        await ctx.db.patch(reservation._id, miseAJour);
      }
    }
    return { reservationId: reservation._id, resultat: args.resultat };
  },
});

// Crée (ou retrouve) le point d'ancrage d'une archive avant l'envoi du fichier.
export const preparerDepot = authenticatedMutation({
  args: {
    licence: v.string(),
    reservationId: v.optional(v.id("abo_test_reservations")),
    resultat: v.optional(v.union(v.literal("valide"), v.literal("non_valide"))),
  },
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
    const reservation = args.reservationId ? await ctx.db.get(args.reservationId) : null;
    if (args.reservationId && (!reservation || reservation.statut !== "active")) {
      throw new ConvexError({
        code: "TEST_RESERVATION_INTROUVABLE",
        message: "Cette réservation de test est introuvable ou annulée.",
      });
    }
    if (reservation && !reservationEstPassee(reservation, new Date().toISOString())) {
      throw new ConvexError({
        code: "TEST_RESULTAT_TROP_TOT",
        message: "Le document ne peut être déposé qu'après la fin du créneau.",
      });
    }
    if (reservation && !args.resultat) {
      throw new ConvexError({
        code: "TEST_RESULTAT_REQUIS",
        message: "Choisissez Validé ou Non validé avant de déposer le formulaire.",
      });
    }
    const licenceReservation = reservation
      ? reservation.candidat_licence
        ?? (reservation.personne_id ? (await ctx.db.get(reservation.personne_id))?.licence : undefined)
      : undefined;
    if (reservation && licenceReservation?.trim() !== licence) {
      throw new ConvexError({
        code: "TEST_LICENCE_INCOHERENTE",
        message: "La licence ne correspond pas à cette réservation.",
      });
    }
    const dejaArchive = args.reservationId
      ? await ctx.db
        .query("abo_tests_autonomie_archive")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", args.reservationId))
        .unique()
      : await ctx.db
        .query("abo_tests_autonomie_archive")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .order("desc")
        .first();
    if (dejaArchive) {
      if (dejaArchive.drive_file_id && dejaArchive.drive_url) {
        throw new ConvexError({
          code: "TEST_DEJA_ARCHIVE",
          message: "Un document est déjà archivé pour cette licence et ne peut pas être remplacé.",
        });
      }
      if (reservation && dejaArchive.resultat_test !== args.resultat) {
        throw new ConvexError({
          code: "TEST_RESULTAT_DOCUMENT_INCOHERENT",
          message: "Le résultat choisi ne correspond pas au document déjà préparé pour cette tentative.",
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
        reservation_id: args.reservationId,
        resultat_test: args.resultat,
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
    resultatTest: v.union(v.literal("valide"), v.literal("non_valide"), v.null()),
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
      resultatTest: archive.resultat_test ?? null,
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
      .first();
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
      .first();
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
