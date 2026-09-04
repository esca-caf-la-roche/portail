// Module « Test d'autonomie » (prise de RDV). Portage de :
//   - test_autonomie.sql (tables abo_test_creneaux / abo_test_reservations)
//   - test_autonomie_rpc.sql + *_tranches.sql + *_tranches_20min.sql (capacité,
//     réservation, surbooking, inscrits) — modèle DÉFINITIF : slots de 20 min,
//     2 candidats / encadrant / slot, tranches proposées de 40 ou 60 min.
//
// Chaque admin propose ses créneaux (jour + plage horaire, alignés 20 min, ≥ 40
// min). On fusionne les dispos de TOUS les encadrants en plages continues de slots
// de 20 min (capacité d'un slot = 2 × nb d'admins distincts qui le couvrent), puis
// on découpe chaque plage en tranches de 3 slots (60 min) puis 2 slots (40 min),
// en privilégiant 60. Le candidat réserve UNE tranche (anonyme : aucune identité
// d'admin exposée — la répartition fine se fait le jour J sur place).
//
// Fuseau : un créneau est saisi en heure de PARIS (date_jour + heure) ; les
// tranches sont des instants (ISO UTC) calculés via parisWallToUtcMs (gère
// l'heure d'été/hiver, cf. config.ts). Le front FORMATE en Europe/Paris.
//
// Sécurité (pas de RLS en Convex) : les mutations candidat vérifient l'owner du
// dossier ; les mutations/queries admin passent par requireAboAdmin. Codes
// d'erreur portés via ConvexError { code, message } (P0002/P0010/P0011/P0012/P0013).
// Pas de verrou consultatif : les mutations Convex sont des transactions
// sérialisables (OCC) → deux réservations concurrentes du même créneau
// re-jouent, la capacité reste respectée.

import { v, ConvexError } from "convex/values";
import { authenticatedQuery, authenticatedMutation } from "../customFunctions";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireAboIdentity, requireAboAdmin } from "./auth";
import { parisWallToUtcMs } from "./config";
import { getAboStaffActifsIds, getAboStaffActifsParId } from "../users";
import { canoniserLicence } from "./lib";
import {
  CLUB_SYNC_ATTEMPT_KEY,
  CLUB_SYNC_COMPLETE_KEY,
  CLUB_SYNC_MAX_AGE_MS,
  MANUAL_SYNC_LOCK_KEYS,
} from "./syncConstants";

const SLOT_MS = 20 * 60 * 1000; // slot de base = 20 min
const MAX_CRENEAUX_STAFF = 200;

const creneauStaffValidator = v.object({
  creneauId: v.id("abo_test_creneaux"),
  date_jour: v.string(),
  heure_debut: v.string(),
  heure_fin: v.string(),
  participants: v.array(v.object({
    nomAffiche: v.string(),
    estMoi: v.boolean(),
  })),
  monCreneauId: v.union(v.id("abo_test_creneaux"), v.null()),
});

async function exigerNomStaffConfigure(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const staffActifs = await getAboStaffActifsParId(ctx, [userId]);
  if (!staffActifs.get(userId)?.name?.trim()) {
    throw new ConvexError({
      code: "ABO_TEST_NOM_STAFF_REQUIS",
      message: "Complétez votre nom dans Configurations avant de proposer ou rejoindre un créneau.",
    });
  }
}

function estReservationActive(r: Doc<"abo_test_reservations">): boolean {
  return r.statut === "active";
}

// ── Tranches (40/60 min) avec capacité cumulée ───────────────────────
// Reproduit test_tranches() : 1) slots de 20 min (cap = 2 × admins distincts) sur
// [début, fin-20min] ; 2) plages continues (slots espacés de 20 min) ; 3) découpe
// en tranches de 3 slots (60) puis 2 slots (40), 60 privilégié.
interface Tranche {
  tranche_debut: string; // ISO UTC (début)
  tranche_fin: string; // ISO UTC (fin)
  capacite: number;
}

async function calculerTranches(ctx: QueryCtx | MutationCtx): Promise<Tranche[]> {
  const creneauxLus = await ctx.db.query("abo_test_creneaux").collect();
  const staffActifs = await getAboStaffActifsIds(
    ctx,
    creneauxLus.map((creneau) => creneau.admin_id),
  );
  const creneaux = creneauxLus.filter((creneau) =>
    staffActifs.has(creneau.admin_id),
  );

  // 1. Capacité par slot de 20 min : Map<instant utc ms, Set<adminId>>.
  const parSlot = new Map<number, Set<string>>();
  for (const c of creneaux) {
    const debut = parisWallToUtcMs(`${c.date_jour}T${c.heure_debut}`);
    const fin = parisWallToUtcMs(`${c.date_jour}T${c.heure_fin}`);
    if (debut == null || fin == null) continue;
    // Slots [début, fin-20min] (le slot doit tenir dans le créneau).
    for (let t = debut; t <= fin - SLOT_MS; t += SLOT_MS) {
      let set = parSlot.get(t);
      if (!set) {
        set = new Set<string>();
        parSlot.set(t, set);
      }
      set.add(c.admin_id);
    }
  }
  if (parSlot.size === 0) return [];

  const slots = [...parSlot.keys()].sort((a, b) => a - b);

  // 2. Plages continues (slots espacés d'exactement 20 min).
  const runs: number[][] = [];
  let courant: number[] = [];
  for (const t of slots) {
    if (courant.length > 0 && t !== courant[courant.length - 1] + SLOT_MS) {
      runs.push(courant);
      courant = [];
    }
    courant.push(t);
  }
  if (courant.length > 0) runs.push(courant);

  // 3. Découpe de chaque plage : k slots → 60 privilégié, reste en 40.
  const out: Tranche[] = [];
  for (const run of runs) {
    const k = run.length;
    let sizes: number[];
    if (k === 1) {
      sizes = [1]; // garde-fou (créneau ≥ 40 min en théorie)
    } else {
      let nb3: number;
      let nb2: number;
      if (k % 3 === 0) {
        nb3 = k / 3;
        nb2 = 0;
      } else if (k % 3 === 1) {
        nb3 = Math.floor(k / 3) - 1;
        nb2 = 2;
      } else {
        nb3 = Math.floor(k / 3);
        nb2 = 1;
      }
      sizes = [
        ...Array<number>(nb3).fill(3),
        ...Array<number>(nb2).fill(2),
      ];
    }

    let i = 0;
    for (const sz of sizes) {
      let somme = 0;
      for (let j = 0; j < sz; j++) {
        somme += 2 * (parSlot.get(run[i + j])?.size ?? 0);
      }
      out.push({
        tranche_debut: new Date(run[i]).toISOString(),
        tranche_fin: new Date(run[i + sz - 1] + SLOT_MS).toISOString(),
        capacite: somme,
      });
      i += sz;
    }
  }
  out.sort((a, b) => a.tranche_debut.localeCompare(b.tranche_debut));
  return out;
}

// Nb de réservations actives par tranche (clé = ISO début).
async function reservationsActivesParTranche(
  ctx: QueryCtx | MutationCtx,
): Promise<Map<string, number>> {
  const actives = await ctx.db
    .query("abo_test_reservations")
    .collect();
  const parTranche = new Map<string, number>();
  for (const r of actives) {
    if (!estReservationActive(r)) continue;
    parTranche.set(r.tranche, (parTranche.get(r.tranche) ?? 0) + 1);
  }
  return parTranche;
}

// ── Candidat : tranches encore disponibles (à venir, place libre) ─────
// Aucune identité d'admin (anonymat). Réservé aux comptes connectés.
export const testCreneauxDisponibles = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireAboIdentity(ctx);
    const tranches = await calculerTranches(ctx);
    const reserves = await reservationsActivesParTranche(ctx);
    const now = Date.now();
    return tranches
      .map((t) => ({
        tranche_debut: t.tranche_debut,
        tranche_fin: t.tranche_fin,
        capacite: t.capacite,
        disponible: t.capacite - (reserves.get(t.tranche_debut) ?? 0),
      }))
      .filter(
        (t) => new Date(t.tranche_debut).getTime() > now && t.disponible > 0,
      );
  },
});

// Charge une personne du dossier de l'appelant (owner). Lève P0002 sinon.
async function personneDuCaller(
  ctx: MutationCtx,
  personneId: Id<"abo_personnes">,
): Promise<{ personne: Doc<"abo_personnes">; dossier: Doc<"abo_dossiers"> }> {
  const id = await requireAboIdentity(ctx);
  const personne = await ctx.db.get(personneId);
  if (!personne) {
    throw new ConvexError({
      code: "P0002",
      message: "Personne introuvable dans votre demande.",
    });
  }
  const dossier = await ctx.db.get(personne.dossier_id);
  if (!dossier || dossier.owner_id !== id.userId) {
    throw new ConvexError({
      code: "P0002",
      message: "Personne introuvable dans votre demande.",
    });
  }
  return { personne, dossier };
}

// Réservation active existante d'une personne (ou null).
async function reservationActive(
  ctx: MutationCtx,
  personneId: Id<"abo_personnes">,
): Promise<Doc<"abo_test_reservations"> | null> {
  const rows = await ctx.db
    .query("abo_test_reservations")
    .withIndex("by_personne", (q) => q.eq("personne_id", personneId))
    .collect();
  return rows.find((r) => r.statut === "active") ?? null;
}

type EligibiliteDirecte = {
  autorisee: boolean;
  motif: "eligible" | "snapshot_a_actualiser" | "licence_invalide" | "eleve_en_cours" | "test_valide" | "age_insuffisant" | "inscription_non_verifiable" | "situation_incomplete";
  message: string;
  candidat: { licence: string; nom: string; prenom: string } | null;
};

async function snapshotClubCompletEtRecent(
  ctx: QueryCtx | MutationCtx,
  maintenantMs: number,
): Promise<boolean> {
  const [verrou, tentative, completion] = await Promise.all([
    ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", MANUAL_SYNC_LOCK_KEYS.scrap))
      .unique(),
    ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_ATTEMPT_KEY))
      .unique(),
    ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_COMPLETE_KEY))
      .unique(),
  ]);
  const instant = tentative?.valeur;
  if (
    !instant ||
    verrou?.valeur !== instant ||
    completion?.valeur !== instant
  ) {
    return false;
  }
  const synchroniseMs = Date.parse(instant);
  const ageMs = maintenantMs - synchroniseMs;
  return Number.isFinite(synchroniseMs) && ageMs >= 0 && ageMs <= CLUB_SYNC_MAX_AGE_MS;
}

const snapshotAActualiser: EligibiliteDirecte = {
  autorisee: false,
  motif: "snapshot_a_actualiser",
  message: "Les inscriptions du club doivent être actualisées. Relancez « Vérifier ma situation ».",
  candidat: null,
};

// Une réservation directe est rattachée à une inscription actuellement visible
// sur le site du club par licence exacte. L'e-mail du scrap n'est pas contrôlé :
// une même adresse peut représenter plusieurs membres d'une famille. Le
// rapprochement nom/prénom ne donne jamais le droit de réserver.
async function eligibiliteDirecte(
  ctx: QueryCtx | MutationCtx,
  licence: string,
): Promise<EligibiliteDirecte> {
  const scrap = await ctx.db
    .query("abo_abonnes_scrap")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .first();
  const inscriptionNonVerifiable: EligibiliteDirecte = {
    autorisee: false,
    motif: "inscription_non_verifiable",
    message: "Nous ne pouvons pas confirmer cette inscription. Vérifiez le numéro de licence utilisé sur le site du club.",
    candidat: null,
  };
  if (!scrap) return inscriptionNonVerifiable;
  const eleve = await ctx.db
    .query("abo_eleves_en_cours")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .first();
  if (eleve) return { autorisee: false, motif: "eleve_en_cours", message: "Vous êtes inscrit·e à un cours : demandez à votre moniteur de vous faire passer le test pendant le cours.", candidat: null };
  if (scrap.autonomie === "OK") return { autorisee: false, motif: "test_valide", message: "Votre test d'autonomie est déjà validé.", candidat: null };
  if (scrap.age === undefined || !scrap.nom || !scrap.prenom || !scrap.autonomie) return { autorisee: false, motif: "situation_incomplete", message: "Votre situation n'est pas encore complète dans les informations du club. Réessayez après la prochaine synchronisation ou contactez la commission.", candidat: null };
  if (scrap.age < 16) return { autorisee: false, motif: "age_insuffisant", message: "Le test d'autonomie est accessible à partir de 16 ans.", candidat: null };
  return { autorisee: true, motif: "eligible", message: "Vous pouvez réserver un créneau de test d'autonomie.", candidat: { licence, nom: scrap.nom, prenom: scrap.prenom } };
}

export const eligibiliteReservationDirecteTest = authenticatedQuery({
  args: { licence: v.string(), maintenantMs: v.number() },
  returns: v.object({
    autorisee: v.boolean(),
    motif: v.union(
      v.literal("eligible"),
      v.literal("snapshot_a_actualiser"),
      v.literal("licence_invalide"),
      v.literal("eleve_en_cours"),
      v.literal("test_valide"),
      v.literal("age_insuffisant"),
      v.literal("inscription_non_verifiable"),
      v.literal("situation_incomplete"),
    ),
    message: v.string(),
    candidat: v.union(
      v.object({ licence: v.string(), nom: v.string(), prenom: v.string() }),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    await requireAboIdentity(ctx);
    if (
      !Number.isFinite(args.maintenantMs) ||
      !(await snapshotClubCompletEtRecent(ctx, args.maintenantMs))
    ) {
      return snapshotAActualiser;
    }
    const licence = canoniserLicence(args.licence);
    if (!licence) {
      return {
        autorisee: false,
        motif: "licence_invalide" as const,
        message: "Le numéro de licence est invalide : 12 ou 14 chiffres attendus.",
        candidat: null,
      };
    }
    return await eligibiliteDirecte(ctx, licence);
  },
});

export const getMesReservationsDirectes = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const id = await requireAboIdentity(ctx);
    const rows = await ctx.db.query("abo_test_reservations")
      .withIndex("by_candidat_user_id", (q) => q.eq("candidat_user_id", id.userId)).collect();
    return rows.filter(estReservationActive).map((r) => ({ id: r._id, licence: r.candidat_licence ?? "", nom: r.candidat_nom ?? "", prenom: r.candidat_prenom ?? "", tranche: r.tranche, tranche_fin: r.tranche_fin ?? null }));
  },
});

export const reserverTestDirect = authenticatedMutation({
  args: { licence: v.string(), tranche: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = await requireAboIdentity(ctx);
    if (!(await snapshotClubCompletEtRecent(ctx, Date.now()))) {
      throw new ConvexError({
        code: "ABO_SNAPSHOT_CLUB_A_ACTUALISER",
        message: snapshotAActualiser.message,
      });
    }
    const licence = canoniserLicence(args.licence);
    if (!licence) {
      throw new ConvexError({
        code: "LICENCE_INVALIDE",
        message: "Le numéro de licence est invalide : 12 ou 14 chiffres attendus.",
      });
    }
    const eligibilite = await eligibiliteDirecte(ctx, licence);
    if (!eligibilite.autorisee || !eligibilite.candidat) throw new ConvexError({ code: "TEST_DIRECT_NON_ELIGIBLE", message: eligibilite.message });
    const existantes = await ctx.db.query("abo_test_reservations")
      .withIndex("by_candidat_licence", (q) => q.eq("candidat_licence", licence)).collect();
    if (existantes.some(estReservationActive)) throw new ConvexError({ code: "P0011", message: "Cette personne a déjà une réservation. Annulez-la pour en changer." });
    const cible = (await calculerTranches(ctx)).find((t) => t.tranche_debut === args.tranche);
    if (!cible || new Date(cible.tranche_debut).getTime() <= Date.now()) throw new ConvexError({ code: "P0012", message: "Ce créneau n'existe pas, ou il est passé." });
    const reserves = await reservationsActivesParTranche(ctx);
    if ((reserves.get(args.tranche) ?? 0) >= cible.capacite) throw new ConvexError({ code: "P0013", message: "Ce créneau est complet, choisissez-en un autre." });
    const rappelPrevuMs = Math.max(
      Date.now(),
      new Date(cible.tranche_debut).getTime() - 24 * 60 * 60 * 1000,
    );
    const reservationId = await ctx.db.insert("abo_test_reservations", {
      candidat_user_id: id.userId,
      candidat_licence: licence,
      candidat_nom: eligibilite.candidat.nom,
      candidat_prenom: eligibilite.candidat.prenom,
      candidat_email: id.email,
      tranche: cible.tranche_debut,
      tranche_fin: cible.tranche_fin,
      statut: "active",
      etat_confirmation: "confirmee",
      rappel_prevu_le: new Date(rappelPrevuMs).toISOString(),
    });
    await ctx.scheduler.runAfter(
      rappelPrevuMs - Date.now(),
      internal.abo.emailsRappel.envoyerRappelTest,
      { reservationId },
    );
    return null;
  },
});

export const annulerMaReservationDirecte = authenticatedMutation({
  args: { reservationId: v.id("abo_test_reservations") },
  handler: async (ctx, args) => {
    const id = await requireAboIdentity(ctx);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || reservation.candidat_user_id !== id.userId) throw new ConvexError({ code: "P0002", message: "Réservation introuvable." });
    if (estReservationActive(reservation)) await ctx.db.patch(reservation._id, { statut: "annulee", annulee_le: new Date().toISOString(), annulee_raison: "candidat" });
    return null;
  },
});

// ── Candidat : réserver une tranche pour une de ses personnes ────────
export const reserverTest = authenticatedMutation({
  args: { personneId: v.id("abo_personnes"), tranche: v.string() },
  handler: async (ctx, args) => {
    const { personne } = await personneDuCaller(ctx, args.personneId);

    if (personne.etape_validation !== "validee") {
      throw new ConvexError({
        code: "P0010",
        message: "La réservation du test est réservée aux demandes validées.",
      });
    }
    if (personne.licence) {
      const eleve = await ctx.db.query("abo_eleves_en_cours")
        .withIndex("by_licence", (q) => q.eq("licence", personne.licence!)).first();
      if (eleve) throw new ConvexError({ code: "TEST_ELEVE_EN_COURS", message: "Vous êtes inscrit·e à un cours : demandez à votre moniteur de vous faire passer le test pendant le cours." });
    }
    if (await reservationActive(ctx, args.personneId)) {
      throw new ConvexError({
        code: "P0011",
        message: "Vous avez déjà une réservation. Annulez-la pour en changer.",
      });
    }

    const tranches = await calculerTranches(ctx);
    const cible = tranches.find((t) => t.tranche_debut === args.tranche);
    if (!cible) {
      throw new ConvexError({
        code: "P0012",
        message: "Ce créneau n'existe pas (ou plus).",
      });
    }
    if (new Date(cible.tranche_debut).getTime() <= Date.now()) {
      throw new ConvexError({
        code: "P0016",
        message: "Ce créneau est passé, choisissez-en un autre.",
      });
    }
    const reserves = await reservationsActivesParTranche(ctx);
    if ((reserves.get(args.tranche) ?? 0) >= cible.capacite) {
      throw new ConvexError({
        code: "P0013",
        message: "Ce créneau est complet, choisissez-en un autre.",
      });
    }

    const rappelPrevuMs = Math.max(
      Date.now(),
      new Date(cible.tranche_debut).getTime() - 24 * 60 * 60 * 1000,
    );
    const reservationId = await ctx.db.insert("abo_test_reservations", {
      personne_id: args.personneId,
      tranche: cible.tranche_debut,
      tranche_fin: cible.tranche_fin,
      statut: "active",
      etat_confirmation: "provisoire",
      rappel_prevu_le: new Date(rappelPrevuMs).toISOString(),
    });
    await ctx.scheduler.runAfter(
      rappelPrevuMs - Date.now(),
      internal.abo.emailsRappel.envoyerRappelTest,
      { reservationId },
    );
    return null;
  },
});

// ── Candidat : annuler sa réservation (libère la place) ──────────────
export const annulerMaReservation = authenticatedMutation({
  args: { personneId: v.id("abo_personnes") },
  handler: async (ctx, args) => {
    await personneDuCaller(ctx, args.personneId);
    const active = await reservationActive(ctx, args.personneId);
    if (active) {
      await ctx.db.patch(active._id, {
        statut: "annulee",
        annulee_le: new Date().toISOString(),
        annulee_raison: "candidat",
      });
    }
    return null;
  },
});

// ── Candidat : réservations de ses personnes (active + annulée subie) ──
// Renvoie, par personne du caller, la réservation active et la dernière
// annulation « subie » (surbooking) — celle-ci sert au bandeau « votre RDV a été
// annulé ». Portage de getMesReservationsParPersonne.
interface ReservationVue {
  id: Id<"abo_test_reservations">;
  tranche: string;
  tranche_fin: string | null;
  statut: "active" | "annulee";
  annulee_le: string | null;
  etat_confirmation: "provisoire" | "confirmee";
  annulee_raison: "candidat" | "creneau_admin_annule" | "conditions_test_non_remplies" | null;
}

function reservationVue(r: Doc<"abo_test_reservations">): ReservationVue {
  return {
    id: r._id,
    tranche: r.tranche,
    tranche_fin: r.tranche_fin ?? null,
    statut: r.statut,
    etat_confirmation: r.etat_confirmation ?? "provisoire",
    annulee_le: r.annulee_le ?? null,
    annulee_raison: r.annulee_raison ?? null,
  };
}

export const getMesReservationsParPersonne = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const id = await requireAboIdentity(ctx);
    const dossiers = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", id.userId))
      .collect();

    const out: {
      personne_id: Id<"abo_personnes">;
      active: ReservationVue | null;
      annulee: ReservationVue | null;
    }[] = [];

    for (const dossier of dossiers) {
      const personnes = await ctx.db
        .query("abo_personnes")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
        .collect();
      for (const p of personnes) {
        const rows = await ctx.db
          .query("abo_test_reservations")
          .withIndex("by_personne", (q) => q.eq("personne_id", p._id))
          .collect();
        // Plus récent d'abord (l'annulée subie la plus récente pour le bandeau).
        rows.sort((a, b) => b._creationTime - a._creationTime);
        const active = rows.find(estReservationActive) ?? null;
        const annulee =
          rows.find(
            (r) =>
              r.statut === "annulee" &&
              (r.annulee_raison === "creneau_admin_annule" ||
                r.annulee_raison === "conditions_test_non_remplies"),
          ) ?? null;
        if (active || annulee) {
          out.push({
            personne_id: p._id,
            active: active ? reservationVue(active) : null,
            annulee: annulee ? reservationVue(annulee) : null,
          });
        }
      }
    }
    return out;
  },
});

// ── Admin : créneaux de dispo de l'admin connecté (jour puis heure) ──
export const getMesCreneaux = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const id = await requireAboAdmin(ctx);
    const creneaux = await ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_admin", (q) => q.eq("admin_id", id.userId))
      .collect();
    creneaux.sort(
      (a, b) =>
        a.date_jour.localeCompare(b.date_jour) ||
        a.heure_debut.localeCompare(b.heure_debut),
    );
    return creneaux.map((c) => ({
      id: c._id,
      date_jour: c.date_jour,
      heure_debut: c.heure_debut,
      heure_fin: c.heure_fin,
    }));
  },
});

// Créneaux à venir de toute l'équipe, regroupés par plage exacte.
// La borne est fournie par le front afin que la query reste stable et n'utilise
// pas Date.now(). Les identifiants et emails des autres membres ne sont jamais
// exposés : seul leur nom d'affichage est utile à la coordination du staff.
export const getCreneauxStaff = authenticatedQuery({
  args: { dateDebut: v.string(), instantReference: v.string() },
  returns: v.array(creneauStaffValidator),
  handler: async (ctx, args) => {
    const id = await requireAboAdmin(ctx);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dateDebut)) {
      throw new ConvexError({
        code: "22023",
        message: "Date de début requise (AAAA-MM-JJ).",
      });
    }
    const instantReferenceMs = Date.parse(args.instantReference);
    if (
      !Number.isFinite(instantReferenceMs) ||
      new Date(instantReferenceMs).toISOString() !== args.instantReference
    ) {
      throw new ConvexError({
        code: "22023",
        message: "Instant de référence ISO invalide.",
      });
    }

    const creneauxLus = await ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_date", (q) => q.gte("date_jour", args.dateDebut))
      .take(MAX_CRENEAUX_STAFF + 1);
    if (creneauxLus.length > MAX_CRENEAUX_STAFF) {
      throw new ConvexError({
        code: "ABO_TEST_TROP_DE_CRENEAUX",
        message: "Trop de créneaux futurs existent pour afficher une vue complète.",
      });
    }
    const staffActifs = await getAboStaffActifsParId(
      ctx,
      creneauxLus.map((creneau) => creneau.admin_id),
    );
    const creneaux = creneauxLus.filter((creneau) => {
      const debut = parisWallToUtcMs(
        `${creneau.date_jour}T${creneau.heure_debut}`,
      );
      return (
        staffActifs.has(creneau.admin_id) &&
        debut !== null &&
        debut > instantReferenceMs
      );
    });

    const adminIds = [...new Set(creneaux.map((creneau) => creneau.admin_id))];
    const nomsParAdmin = new Map(
      adminIds.map((adminId) => [
        adminId,
        staffActifs.get(adminId)?.name?.trim() || "Nom à compléter",
      ]),
    );

    const groupes = new Map<string, Doc<"abo_test_creneaux">[]>();
    for (const creneau of creneaux) {
      const cle = `${creneau.date_jour}\u0000${creneau.heure_debut}\u0000${creneau.heure_fin}`;
      const groupe = groupes.get(cle) ?? [];
      groupe.push(creneau);
      groupes.set(cle, groupe);
    }

    return [...groupes.values()]
      .map((groupe) => {
        const reference = groupe[0];
        const parAdmin = new Map<Id<"users">, Doc<"abo_test_creneaux">>();
        for (const creneau of groupe) {
          if (!parAdmin.has(creneau.admin_id)) {
            parAdmin.set(creneau.admin_id, creneau);
          }
        }
        const monCreneau = parAdmin.get(id.userId);
        const participants = [...parAdmin.keys()]
          .map((adminId) => ({
            nomAffiche: nomsParAdmin.get(adminId) ?? "Nom à compléter",
            estMoi: adminId === id.userId,
          }))
          .sort((a, b) =>
            a.nomAffiche.localeCompare(b.nomAffiche, "fr", {
              sensitivity: "base",
            }),
          );

        return {
          creneauId: reference._id,
          date_jour: reference.date_jour,
          heure_debut: reference.heure_debut,
          heure_fin: reference.heure_fin,
          participants,
          monCreneauId: monCreneau?._id ?? null,
        };
      })
      .sort(
        (a, b) =>
          a.date_jour.localeCompare(b.date_jour) ||
          a.heure_debut.localeCompare(b.heure_debut) ||
          a.heure_fin.localeCompare(b.heure_fin),
      );
  },
});

// Date du jour (Europe/Paris) au format 'YYYY-MM-DD' pour interdire le passé.
function todayParisISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );
}

// 'HH:mm' → minutes depuis minuit, ou null si mal formé.
function hhmmEnMinutes(t: string): number | null {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

// ── Admin : créer un créneau (aligné 20 min, durée ≥ 40 min) ─────────
export const creerTestCreneau = authenticatedMutation({
  args: { date: v.string(), debut: v.string(), fin: v.string() },
  returns: v.id("abo_test_creneaux"),
  handler: async (ctx, args) => {
    const id = await requireAboAdmin(ctx);
    await exigerNomStaffConfigure(ctx, id.userId);

    const err = (message: string) => {
      throw new ConvexError({ code: "22023", message });
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      err("Jour requis (AAAA-MM-JJ).");
    }
    const deb = hhmmEnMinutes(args.debut);
    const fin = hhmmEnMinutes(args.fin);
    if (deb == null || fin == null) {
      err("Heures de début et de fin requises (HH:mm).");
    }
    const d = deb as number;
    const f = fin as number;
    if (d >= f) {
      err("L'heure de fin doit être après l'heure de début.");
    }
    if (d % 20 !== 0 || f % 20 !== 0) {
      err("Les heures doivent être alignées sur 20 min (00, 20 ou 40).");
    }
    if (f - d < 40) {
      err("Le créneau doit durer au moins 40 minutes.");
    }
    if (args.date < todayParisISO()) {
      err("Le jour du créneau ne peut pas être dans le passé.");
    }
    const debutCreneau = parisWallToUtcMs(`${args.date}T${args.debut}`);
    if (debutCreneau == null || debutCreneau <= Date.now()) {
      err("Le début du créneau doit être dans le futur.");
    }

    const creneauxDuJour = await ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_date", (q) => q.eq("date_jour", args.date))
      .take(MAX_CRENEAUX_STAFF + 1);
    const existant = creneauxDuJour.find(
      (creneau) =>
        creneau.admin_id === id.userId &&
        creneau.heure_debut === args.debut &&
        creneau.heure_fin === args.fin,
    );
    if (existant) return existant._id;
    if (creneauxDuJour.length >= MAX_CRENEAUX_STAFF) {
      throw new ConvexError({
        code: "ABO_TEST_TROP_DE_CRENEAUX",
        message: "Trop de créneaux existent déjà pour cette journée.",
      });
    }

    return await ctx.db.insert("abo_test_creneaux", {
      admin_id: id.userId,
      date_jour: args.date,
      heure_debut: args.debut,
      heure_fin: args.fin,
    });
  },
});

// Rejoindre la plage exacte d'un autre membre du staff. La mutation est
// idempotente : rejouer le clic renvoie le créneau existant de l'appelant.
export const rejoindreTestCreneau = authenticatedMutation({
  args: { creneauId: v.id("abo_test_creneaux") },
  returns: v.id("abo_test_creneaux"),
  handler: async (ctx, args) => {
    const id = await requireAboAdmin(ctx);
    await exigerNomStaffConfigure(ctx, id.userId);
    const reference = await ctx.db.get(args.creneauId);
    if (!reference) {
      throw new ConvexError({ code: "P0002", message: "Créneau introuvable." });
    }
    const proprietairesActifs = await getAboStaffActifsIds(ctx, [
      reference.admin_id,
    ]);
    if (!proprietairesActifs.has(reference.admin_id)) {
      throw new ConvexError({
        code: "ABO_TEST_STAFF_INACTIF",
        message: "Ce créneau n'est plus proposé par un membre du staff Abonnements.",
      });
    }

    const debutCreneau = parisWallToUtcMs(
      `${reference.date_jour}T${reference.heure_debut}`,
    );
    if (debutCreneau == null || debutCreneau <= Date.now()) {
      throw new ConvexError({
        code: "P0016",
        message: "Ce créneau est passé, vous ne pouvez plus le rejoindre.",
      });
    }

    const creneauxDuJour = await ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_date", (q) => q.eq("date_jour", reference.date_jour))
      .take(MAX_CRENEAUX_STAFF + 1);
    const existant = creneauxDuJour.find(
      (creneau) =>
        creneau.admin_id === id.userId &&
        creneau.heure_debut === reference.heure_debut &&
        creneau.heure_fin === reference.heure_fin,
    );
    if (existant) return existant._id;
    if (creneauxDuJour.length >= MAX_CRENEAUX_STAFF) {
      throw new ConvexError({
        code: "ABO_TEST_TROP_DE_CRENEAUX",
        message: "Trop de créneaux existent déjà pour cette journée.",
      });
    }

    return await ctx.db.insert("abo_test_creneaux", {
      admin_id: id.userId,
      date_jour: reference.date_jour,
      heure_debut: reference.heure_debut,
      heure_fin: reference.heure_fin,
    });
  },
});

// ── Admin : supprimer un créneau + résoudre le surbooking (LIFO) ─────
// Après retrait, les bornes de tranche peuvent bouger (fusion des plages). Pour
// chaque tranche ayant des réservations actives, on recompare aux capacités
// recalculées ; le surplus (ou les réservations dont la tranche n'existe plus →
// capacité 0) est annulé en LIFO (dernier inscrit, premier délogé) et journalisé
// (email_log 'test_annule', envoi réel branché en Phase J). Renvoie le nb annulé.
export const supprimerTestCreneau = authenticatedMutation({
  args: { creneauId: v.id("abo_test_creneaux") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const id = await requireAboAdmin(ctx);

    const creneau = await ctx.db.get(args.creneauId);
    if (!creneau) {
      throw new ConvexError({ code: "P0002", message: "Créneau introuvable." });
    }
    if (creneau.admin_id !== id.userId) {
      throw new ConvexError({
        code: "42501",
        message: "Vous ne pouvez supprimer que vos propres créneaux.",
      });
    }

    const creneauxDuCaller = await ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_admin", (q) => q.eq("admin_id", id.userId))
      .collect();
    const doublonsExacts = creneauxDuCaller.filter(
      (ligne) =>
        ligne.date_jour === creneau.date_jour &&
        ligne.heure_debut === creneau.heure_debut &&
        ligne.heure_fin === creneau.heure_fin,
    );
    for (const doublon of doublonsExacts) {
      await ctx.db.delete(doublon._id);
    }

    // Capacités recalculées (sans ce créneau).
    const tranches = await calculerTranches(ctx);
    const capParTranche = new Map(tranches.map((t) => [t.tranche_debut, t.capacite]));

    // Toutes les réservations actives, groupées par tranche.
    const actives = (await ctx.db.query("abo_test_reservations").collect()).filter(
      estReservationActive,
    );
    const parTranche = new Map<string, Doc<"abo_test_reservations">[]>();
    for (const r of actives) {
      const list = parTranche.get(r.tranche) ?? [];
      list.push(r);
      parTranche.set(r.tranche, list);
    }

    let total = 0;
    for (const [tranche, list] of parTranche) {
      const cap = capParTranche.get(tranche) ?? 0;
      const surplus = list.length - cap;
      if (surplus <= 0) continue;
      // LIFO : les plus récents d'abord.
      list.sort((a, b) => b._creationTime - a._creationTime);
      for (const r of list.slice(0, surplus)) {
        await ctx.db.patch(r._id, {
          statut: "annulee",
          annulee_le: new Date().toISOString(),
          annulee_raison: "creneau_admin_annule",
        });
        // Notifie l'annulation (envoi réel via la boîte abo ; journalisation
        // dans abo_email_log faite par le pipeline, sans dedup pour test_annule).
        if (!r.personne_id) {
          await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerAnnulationCreneauTest, {
            reservationId: r._id,
          });
        } else {
          const personne = await ctx.db.get(r.personne_id);
          const dossier = personne ? await ctx.db.get(personne.dossier_id) : null;
          if (dossier) {
            await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerEmailAbo, {
              dossierId: dossier._id,
              typeEmail: "test_annule",
            });
          }
        }
        total++;
      }
    }
    return total;
  },
});

// ── Admin : liste globale des inscrits par tranche (jour J) ──────────
export const testInscritsAdmin = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    reservationId: v.id("abo_test_reservations"),
    tranche_debut: v.string(),
    tranche_fin: v.union(v.string(), v.null()),
    etat_confirmation: v.union(v.literal("provisoire"), v.literal("confirmee")),
    personne_id: v.union(v.id("abo_personnes"), v.null()),
    licence: v.string(),
    nom: v.string(),
    prenom: v.string(),
    email: v.string(),
  })),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const actives = (await ctx.db.query("abo_test_reservations").collect()).filter(
      estReservationActive,
    );
    actives.sort(
      (a, b) => a.tranche.localeCompare(b.tranche) || a._creationTime - b._creationTime,
    );

    const out: {
      tranche_debut: string;
      tranche_fin: string | null;
      etat_confirmation: "provisoire" | "confirmee";
      reservationId: Id<"abo_test_reservations">;
      personne_id: Id<"abo_personnes"> | null;
      licence: string;
      nom: string;
      prenom: string;
      email: string;
    }[] = [];
    for (const r of actives) {
      if (!r.personne_id) {
        if (!r.candidat_licence || !r.candidat_nom || !r.candidat_prenom || !r.candidat_email) continue;
        out.push({
          reservationId: r._id,
          tranche_debut: r.tranche,
          tranche_fin: r.tranche_fin ?? null,
          etat_confirmation: r.etat_confirmation ?? "confirmee",
          personne_id: null,
          licence: r.candidat_licence,
          nom: r.candidat_nom,
          prenom: r.candidat_prenom,
          email: r.candidat_email,
        });
        continue;
      }
      const personne = await ctx.db.get(r.personne_id);
      if (!personne) continue;
      const dossier = await ctx.db.get(personne.dossier_id);
      out.push({
        reservationId: r._id,
        tranche_debut: r.tranche,
        tranche_fin: r.tranche_fin ?? null,
        etat_confirmation: r.etat_confirmation ?? "provisoire",
        personne_id: personne._id,
        licence: personne.licence ?? "",
        nom: personne.nom,
        prenom: personne.prenom,
        email: dossier?.email ?? "",
      });
    }
    return out;
  },
});
