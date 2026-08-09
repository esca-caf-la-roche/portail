// Résolution des licences des demandes (annuaire abo_licences ↔ nom/prénom).
// La licence est la clé qui relie demandes / scrap / cours. Portage de :
//   - resoudre_licences.sql + valider_licence_nom_prenom.sql (résolution auto)
//   - v_licences_a_valider.sql (candidats fuzzy)
//   - valider_licence.sql (validation manuelle)
//   - licences.sql / import-licences.js (annuaire + upsert)
//
// pg_trgm (extension Postgres) → similarité trigram JS (similarite de ./lib).
// RLS admin → requireAboAdmin. Triggers de normalisation → helpers appelés ici.

import { v, ConvexError } from "convex/values";
import {
  authenticatedQuery,
  authenticatedMutation,
  authenticatedAction,
} from "../customFunctions";
import { internalMutation, internalAction } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { requireAboAdmin } from "./auth";
import { canoniserLicence, normaliserNomPrenom, similarite } from "./lib";
import { champsModifies } from "../dbUtils";

// Annuaire des licences du club (export JSON protégé par Basic Auth DÉDIÉE).
const URL_ANNUAIRE =
  "https://www.caflarochebonneville.fr/test_script/export_licence.php";

// Seuil de similarité trigram (défaut de pg_trgm : 0.3) pour retenir un candidat.
const SEUIL_TRGM = 0.3;
const MAX_ANNUAIRE_LICENCES = 1_000;
const ANNUAIRE_SYNC_KEY = "last_sync_annuaire";
const ANNUAIRE_TTL_MS = 12 * 60 * 60_000;
const MAX_CANDIDATS = 5;

// ── getLicencesAValider : personnes sans licence + candidats fuzzy ───
// Regroupé par personne (une carte = une personne + ses meilleurs candidats).
export const getLicencesAValider = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireAboAdmin(ctx);

    // Personnes non résolues (licence absente) — index by_licence sur undefined.
    const nonResolues = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", undefined))
      .collect();
    if (nonResolues.length === 0) return [];

    // Annuaire complet (borné par la taille réelle du club).
    const annuaire = await ctx.db.query("abo_licences").collect();

    const out = nonResolues.map((p) => {
      const inverse = normaliserNomPrenom(p.prenom, p.nom);
      const candidats = annuaire
        .map((l) => ({
          l,
          score: Math.max(
            similarite(p.nom_prenom_normalise, l.nom_prenom_normalise),
            similarite(inverse, l.nom_prenom_normalise),
          ),
        }))
        .filter((x) => x.score >= SEUIL_TRGM)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATS)
        .map((x) => ({
          licence: x.l.licence,
          nom: x.l.nom ?? null,
          prenom: x.l.prenom ?? null,
          score: x.score,
        }));
      return {
        personne_id: p._id,
        nom: p.nom,
        prenom: p.prenom,
        candidats,
      };
    });

    // Tri lisible : par nom puis prénom.
    out.sort((a, b) =>
      `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, "fr"),
    );
    return out;
  },
});

// Aligne nom/prénom d'une personne sur la fiche annuaire d'une licence, et pose
// la licence + son statut. Recalcule nom_prenom_normalise (ex-trigger).
async function autrePorteuseLicence(
  ctx: MutationCtx,
  personneId: Doc<"abo_personnes">["_id"],
  licence: string,
): Promise<Doc<"abo_personnes"> | null> {
  const porteuses = await ctx.db
    .query("abo_personnes")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .take(2);
  return porteuses.find((porteuse) => porteuse._id !== personneId) ?? null;
}

async function poserLicence(
  ctx: MutationCtx,
  personne: Doc<"abo_personnes">,
  licence: string,
  statut: "annuaire_auto" | "annuaire_valide",
  fiche: Doc<"abo_licences"> | null,
): Promise<boolean> {
  if (await autrePorteuseLicence(ctx, personne._id, licence)) {
    return false;
  }
  const nom = fiche?.nom ?? personne.nom;
  const prenom = fiche?.prenom ?? personne.prenom;
  await ctx.db.patch(personne._id, {
    licence,
    licence_statut: statut,
    nom,
    prenom,
    nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
  });
  return true;
}

// ── resoudreLicencesPersonnes : match exact unique (auto) ────────────
export const resoudreLicencesPersonnes = authenticatedMutation({
  args: {},
  handler: async (ctx) => {
    await requireAboAdmin(ctx);

    const nonResolues = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", undefined))
      .collect();

    let resolues = 0;
    for (const p of nonResolues) {
      const cleDirecte = p.nom_prenom_normalise;
      const cleInverse = normaliserNomPrenom(p.prenom, p.nom);

      // Licences distinctes de l'annuaire correspondant à l'une des deux clés.
      const distinctes = new Set<string>();
      const fiches = new Map<string, Doc<"abo_licences">>();
      const cles = cleInverse === cleDirecte ? [cleDirecte] : [cleDirecte, cleInverse];
      for (const cle of cles) {
        const rows = await ctx.db
          .query("abo_licences")
          .withIndex("by_nom_prenom_normalise", (q) =>
            q.eq("nom_prenom_normalise", cle),
          )
          .collect();
        for (const r of rows) {
          distinctes.add(r.licence);
          fiches.set(r.licence, r);
        }
      }

      // Résolue SSI l'annuaire contient EXACTEMENT une licence correspondante.
      if (distinctes.size === 1) {
        const licence = [...distinctes][0];
        if (await poserLicence(ctx, p, licence, "annuaire_auto", fiches.get(licence) ?? null)) {
          resolues++;
        }
      }
    }
    return resolues;
  },
});

// ── validerLicence : association manuelle (admin) ────────────────────
export const validerLicence = authenticatedMutation({
  args: { personneId: v.id("abo_personnes"), licence: v.string() },
  returns: v.union(
    v.object({ statut: v.literal("attribue"), licence: v.string() }),
    v.object({
      statut: v.literal("conflit"),
      licence: v.string(),
      personneExistanteId: v.id("abo_personnes"),
      personneCibleDossierId: v.id("abo_dossiers"),
      personneExistanteDossierId: v.id("abo_dossiers"),
      personneExistanteNom: v.string(),
      personneExistantePrenom: v.string(),
      personneExistanteEmail: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const licence = canoniserLicence(args.licence);
    if (licence === null) {
      throw new ConvexError({
        code: "22023",
        message: "Numéro de licence invalide (12 chiffres attendus).",
      });
    }
    const personne = await ctx.db.get(args.personneId);
    if (!personne) {
      throw new ConvexError({ code: "P0002", message: "Personne introuvable." });
    }
    // Correspondance annuaire (aligne nom/prénom si la licence y figure).
    const fiche = await ctx.db
      .query("abo_licences")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .first();
    const porteuse = await autrePorteuseLicence(ctx, personne._id, licence);
    if (porteuse) {
      const dossierPorteuse = await ctx.db.get(porteuse.dossier_id);
      return {
        statut: "conflit" as const,
        licence,
        personneExistanteId: porteuse._id,
        personneCibleDossierId: personne.dossier_id,
        personneExistanteDossierId: porteuse.dossier_id,
        personneExistanteNom: porteuse.nom,
        personneExistantePrenom: porteuse.prenom,
        personneExistanteEmail: dossierPorteuse?.email ?? null,
      };
    }
    if (!await poserLicence(ctx, personne, licence, "annuaire_valide", fiche)) {
      throw new ConvexError({
        code: "LICENCE_CONCURRENTE",
        message: "Cette licence vient d'être affectée à une autre personne. Réessayez pour voir le conflit.",
      });
    }
    return { statut: "attribue" as const, licence };
  },
});

// ── upsertLicencesBatch : import annuaire (interne, appelé par l'action) ──
// Upsert par licence canonique ; recalcule nom_prenom_normalise. Ignore les
// enregistrements sans licence exploitable.
// Conflits réels : une même licence ne doit désigner qu'une seule personne.
// La liste est bornée au volume réel de la campagne; aucun rapprochement par
// nom/prénom n'est effectué automatiquement.
export const getConflitsLicences = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    licence: v.string(),
    personnes: v.array(v.object({
      personneId: v.id("abo_personnes"),
      dossierId: v.id("abo_dossiers"),
      nom: v.string(),
      prenom: v.string(),
      email: v.string(),
      etapeValidation: v.union(
        v.literal("en_attente"),
        v.literal("validee"),
        v.literal("liste_attente"),
        v.literal("refusee"),
      ),
      reservationActive: v.boolean(),
    })),
  })),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence")
      .take(500);
    const parLicence = new Map<string, typeof personnes>();
    for (const personne of personnes) {
      if (!personne.licence) continue;
      const groupe = parLicence.get(personne.licence) ?? [];
      groupe.push(personne);
      parLicence.set(personne.licence, groupe);
    }
    const conflits = [] as Array<{
      licence: string;
      personnes: Array<{
        personneId: Doc<"abo_personnes">["_id"];
        dossierId: Doc<"abo_dossiers">["_id"];
        nom: string;
        prenom: string;
        email: string;
        etapeValidation: Doc<"abo_personnes">["etape_validation"];
        reservationActive: boolean;
      }>;
    }>;
    for (const [licence, groupe] of parLicence) {
      if (groupe.length < 2) continue;
      const vues = [] as (typeof conflits)[number]["personnes"];
      for (const personne of groupe) {
        const dossier = await ctx.db.get(personne.dossier_id);
        if (!dossier) continue;
        const reservations = await ctx.db
          .query("abo_test_reservations")
          .withIndex("by_personne", (q) => q.eq("personne_id", personne._id))
          .take(20);
        vues.push({
          personneId: personne._id,
          dossierId: dossier._id,
          nom: personne.nom,
          prenom: personne.prenom,
          email: dossier.email,
          etapeValidation: personne.etape_validation,
          reservationActive: reservations.some((reservation) => reservation.statut === "active"),
        });
      }
      if (vues.length > 1) conflits.push({ licence, personnes: vues });
    }
    return conflits.sort((a, b) => a.licence.localeCompare(b.licence));
  },
});

// Compatibilité temporaire avec les anciens clients déjà chargés. La fusion
// partielle est désactivée : le nouveau parcours fusionne le dossier complet via
// `abo/fusionsDossiers.ts`.
export const fusionnerPersonnesLicence = authenticatedMutation({
  args: {
    personneSourceId: v.id("abo_personnes"),
    personneCibleId: v.id("abo_personnes"),
  },
  returns: v.object({
    personneCibleId: v.id("abo_personnes"),
    reservationsReaffectees: v.number(),
    dossierSourceSupprime: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    // DEPRECATED: l'ancienne fusion partielle ne gérait ni comptes, ni famille,
    // ni audit complet. Elle reste temporairement déclarée pour ne pas casser
    // un ancien client déjà chargé, mais aucune écriture n'est désormais permise.
    throw new ConvexError({
      code: "FUSION_ENDPOINT_OBSOLETE",
      message: "Cette fusion n'est plus disponible. Rechargez la page pour utiliser la fusion complète des dossiers.",
    });
  },
});

export const upsertLicencesBatch = internalMutation({
  args: {
    lignes: v.array(
      v.object({
        licence: v.string(),
        nom: v.optional(v.string()),
        prenom: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const maintenant = new Date().toISOString();
    let upsertees = 0;
    for (const ligne of args.lignes) {
      const licence = canoniserLicence(ligne.licence);
      if (licence === null) continue;
      const nom = (ligne.nom ?? "").trim() || undefined;
      const prenom = (ligne.prenom ?? "").trim() || undefined;
      const doc = {
        licence,
        nom,
        prenom,
        nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        imported_at: maintenant,
      };
      const existant = await ctx.db
        .query("abo_licences")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .first();
      if (existant) {
        // `imported_at` change à chaque import : ignoré pour ne réécrire (et ne
        // réinvalider les queries de résolution/candidats) qu'en cas de vrai
        // changement nom/prénom de la fiche annuaire.
        if (champsModifies(existant, doc, ["imported_at"])) {
          await ctx.db.patch(existant._id, doc);
        }
      } else {
        await ctx.db.insert("abo_licences", doc);
      }
      upsertees++;
    }
    return upsertees;
  },
});

// ── supprimerLicencesAbsentes : finalise un snapshot FFCAM complet ───────
// L'annuaire est une référence externe : cette purge ne modifie ni les
// licences déjà attribuées aux personnes ni leurs dossiers portail.
export const supprimerLicencesAbsentes = internalMutation({
  args: { licences: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    if (args.licences.length === 0) {
      throw new Error("Refus de purger l'annuaire sans licence reçue.");
    }
    if (args.licences.length > MAX_ANNUAIRE_LICENCES) {
      throw new Error(`L'annuaire dépasse la limite de ${MAX_ANNUAIRE_LICENCES} licences.`);
    }

    const licencesRecues = new Set(args.licences.map(canoniserLicence).filter(Boolean));
    if (licencesRecues.size === 0) {
      throw new Error("Refus de purger l'annuaire sans licence exploitable.");
    }

    // IO-BOUNDED: l'annuaire FFCAM du club est borné à 1 000 fiches ; on lit
    // au plus 1 001 entrées pour détecter une croissance avant toute purge.
    const existantes = await ctx.db.query("abo_licences").take(MAX_ANNUAIRE_LICENCES + 1);
    if (existantes.length > MAX_ANNUAIRE_LICENCES) {
      throw new Error(`Le cache annuaire dépasse la limite de ${MAX_ANNUAIRE_LICENCES} licences.`);
    }

    let supprimees = 0;
    for (const existante of existantes) {
      if (!licencesRecues.has(existante.licence)) {
        await ctx.db.delete(existante._id);
        supprimees++;
      }
    }
    return supprimees;
  },
});

// ── importerAnnuaireLicences : télécharge l'annuaire et upsert (admin) ──
// Portage de scripts/import-licences.js. 🔒 Basic Auth dédiée (LICENCES_USER /
// LICENCES_PASSWORD) jamais loggués ; on ne remonte que des compteurs. Fallback
// clair si les secrets manquent (comme sendAboEmail).
interface LigneAnnuaire {
  numero_licence?: string | number;
  nom?: string;
  prenom?: string;
}

export const importerAnnuaireLicences = authenticatedAction({
  args: {},
  returns: v.object({
    statut: v.union(v.literal("done"), v.literal("skipped")),
    retryAt: v.union(v.string(), v.null()),
    upsertees: v.number(),
    recus: v.number(),
    supprimees: v.number(),
  }),
  handler: async (ctx): Promise<{
    statut: "done" | "skipped";
    retryAt: string | null;
    upsertees: number;
    recus: number;
    supprimees: number;
  }> => {
    const me = await ctx.runQuery(api.abo.identity.me, {});
    if (!me || me.aboRole !== "admin") {
      throw new Error("Réservé aux administrateurs.");
    }
    const reservation = await ctx.runMutation(internal.abo.sync.reserverSync, {
      cle: ANNUAIRE_SYNC_KEY,
      ttlMs: ANNUAIRE_TTL_MS,
    });
    if (!reservation.proceed) {
      const lastMs = reservation.precedent ? Date.parse(reservation.precedent) : NaN;
      return {
        statut: "skipped",
        retryAt: Number.isFinite(lastMs) ? new Date(lastMs + ANNUAIRE_TTL_MS).toISOString() : null,
        upsertees: 0,
        recus: 0,
        supprimees: 0,
      };
    }
    try {
      const resultat: { upsertees: number; recus: number; supprimees: number } =
        await ctx.runAction(internal.abo.licences.importerAnnuaireLicencesInternal, {});
      return { statut: "done", retryAt: null, ...resultat };
    } catch (error) {
      await ctx.runMutation(internal.abo.sync.restaurerMarqueur, {
        cle: ANNUAIRE_SYNC_KEY,
        valeur: reservation.precedent,
      });
      throw error;
    }
  },
});

// ── importerAnnuaireLicencesInternal : logique partagée (cron + action admin) ──
export const importerAnnuaireLicencesInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<{ upsertees: number; recus: number; supprimees: number }> => {
    const user = process.env.LICENCES_USER;
    const pass = process.env.LICENCES_PASSWORD;
    if (!user || !pass) {
      throw new Error(
        "Annuaire non configuré (LICENCES_USER / LICENCES_PASSWORD manquants).",
      );
    }

    const auth = "Basic " + btoa(`${user}:${pass}`);
    const res = await fetch(URL_ANNUAIRE, { headers: { Authorization: auth } });
    if (!res.ok) {
      throw new Error(`Téléchargement de l'annuaire : HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error("Réponse inattendue de l'annuaire (tableau JSON attendu).");
    }

    // Déduplication sur la licence canonique (clé d'upsert).
    const parLicence = new Map<
      string,
      { licence: string; nom?: string; prenom?: string }
    >();
    for (const o of data as LigneAnnuaire[]) {
      const licence = canoniserLicence(String(o.numero_licence ?? ""));
      if (!licence) continue;
      parLicence.set(licence, {
        licence,
        nom: String(o.nom ?? "").trim() || undefined,
        prenom: String(o.prenom ?? "").trim() || undefined,
      });
    }
    const lignes = [...parLicence.values()];
    if (lignes.length === 0) {
      throw new Error(
        "0 licence exploitable — authentification KO ou format de l'annuaire modifié.",
      );
    }
    if (lignes.length > MAX_ANNUAIRE_LICENCES) {
      throw new Error(
        `L'annuaire dépasse la limite de ${MAX_ANNUAIRE_LICENCES} licences ; aucune donnée n'a été modifiée.`,
      );
    }

    // Upsert par lots (transactions bornées).
    let upsertees = 0;
    for (let i = 0; i < lignes.length; i += 200) {
      const lot = lignes.slice(i, i + 200);
      const n: number = await ctx.runMutation(
        internal.abo.licences.upsertLicencesBatch,
        { lignes: lot },
      );
      upsertees += n;
    }
    const supprimees: number = await ctx.runMutation(internal.abo.licences.supprimerLicencesAbsentes, {
      licences: lignes.map((ligne) => ligne.licence),
    });
    return { upsertees, recus: data.length, supprimees };
  },
});
