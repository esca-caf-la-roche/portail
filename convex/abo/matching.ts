// Matching scrap → personnes (runtime Convex par défaut, PAS de "use node").
// Portage de matcher_scrap_personnes() (migration licence-first 20260614) :
//   - Passe 1 LICENCE-FIRST : personnes ayant une licence ↔ scrap par licence
//     (abo_abonnes_scrap.licence est unique → au plus 1 match).
//   - Passe 2 SECOURS nom+prénom : personnes SANS licence ↔ scrap par
//     nom_prenom_normalise, uniquement les noms NON ambigus (1 seule ligne scrap).
//     Cette passe RÉSOUT aussi leur licence (statut annuaire_auto).
//   - etape_paiement : NON piloté par le scrap (la migration licence-first l'a
//     retiré) mais par HelloAsso — matching payeur/inscrit du formulaire abo.
//
// Réservé aux appels internes (scrap Phase H) : internalMutation, pas d'API
// publique. Volume borné par la taille du club (scrap ≈ places, personnes = saison).

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { canoniserLicence, normaliserNomPrenom } from "./lib";
import { trouverLienAbo, estRemboursement } from "./paiements";
import { champsModifies } from "../dbUtils";
import { abonnementEstValide } from "./statutAbonnement";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

// Le site du club fournit une liste complète d'abonnés, plafonnée par la
// capacité de la campagne. Au-delà, on échoue sans rien purger : une campagne
// plus grande doit d'abord relever explicitement cette borne.
const MAX_ABONNES_SCRAP = 500;

// ── upsertAbonnesScrapBatch : miroir brut de la page club (par licence) ──
// Comme le scrap Supabase, on n'écrit QUE les lignes ayant une licence (clé
// d'unicité) ; les autres sont comptées et ignorées. Idempotent (patch/insert).
export const upsertAbonnesScrapBatch = internalMutation({
  args: {
    lignes: v.array(
      v.object({
        licence: v.optional(v.string()),
        nom: v.optional(v.string()),
        prenom: v.optional(v.string()),
        email: v.optional(v.string()),
        age: v.optional(v.number()),
        micro_perf: v.optional(v.string()),
        nb_seances: v.optional(v.string()),
        adhesion: v.optional(v.string()),
        autonomie: v.optional(v.string()),
        photo: v.optional(v.string()),
        paiement: v.optional(v.string()),
        abonnement_valide: v.union(
          v.literal("oui"),
          v.literal("non"),
          v.literal("bloque"),
        ),
      }),
    ),
  },
  returns: v.object({ upsertees: v.number(), sansLicence: v.number() }),
  handler: async (ctx, args) => {
    const maintenant = new Date().toISOString();
    let upsertees = 0;
    let sansLicence = 0;
    for (const l of args.lignes) {
      const licence = canoniserLicence(l.licence);
      if (!licence) {
        sansLicence++;
        continue;
      }
      const nom = (l.nom ?? "").trim() || undefined;
      const prenom = (l.prenom ?? "").trim() || undefined;
      const doc = {
        licence,
        nom,
        prenom,
        nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        email: (l.email ?? "").trim() || undefined,
        age: l.age,
        micro_perf: (l.micro_perf ?? "").trim() || undefined,
        nb_seances: (l.nb_seances ?? "").trim() || undefined,
        adhesion: (l.adhesion ?? "").trim() || undefined,
        autonomie: (l.autonomie ?? "").trim() || undefined,
        photo: (l.photo ?? "").trim() || undefined,
        paiement: (l.paiement ?? "").trim() || undefined,
        abonnement_valide: l.abonnement_valide,
        last_scrap_at: maintenant,
      };
      const existant = await ctx.db
        .query("abo_abonnes_scrap")
        .withIndex("by_licence", (q) => q.eq("licence", licence))
        .first();
      if (existant) {
        // `last_scrap_at` change à chaque passage : on l'ignore pour ne
        // réécrire (et ne réinvalider les queries temps réel) qu'en cas de
        // vrai changement des données de l'abonné·e.
        if (champsModifies(existant, doc, ["last_scrap_at"])) {
          await ctx.db.patch(existant._id, doc);
        }
      } else {
        await ctx.db.insert("abo_abonnes_scrap", doc);
      }
      upsertees++;
    }
    return { upsertees, sansLicence };
  },
});

// ── supprimerAbonnesScrapAbsents : finalise un snapshot club complet ─────
// Appelée seulement après que l'action de scrap a lu et upserté une liste non
// vide. Les licences reçues sont la source de vérité du snapshot courant ; les
// anciennes lignes absentes sont retirées du cache local (jamais du site club).
export const supprimerAbonnesScrapAbsents = internalMutation({
  args: { licences: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    if (args.licences.length === 0) {
      throw new Error("Refus de purger le snapshot abonnés sans licence reçue.");
    }
    if (args.licences.length > MAX_ABONNES_SCRAP) {
      throw new Error(`Le snapshot abonnés dépasse la limite de ${MAX_ABONNES_SCRAP} lignes.`);
    }

    const licencesRecues = new Set(args.licences.map(canoniserLicence).filter(Boolean));
    if (licencesRecues.size === 0) {
      throw new Error("Refus de purger le snapshot abonnés sans licence exploitable.");
    }

    // IO-BOUNDED: le snapshot club est limité à 500 abonnés ; on borne la
    // lecture à 501 pour détecter une hausse de capacité avant toute purge.
    const existants = await ctx.db.query("abo_abonnes_scrap").take(MAX_ABONNES_SCRAP + 1);
    if (existants.length > MAX_ABONNES_SCRAP) {
      throw new Error(`Le cache abonnés dépasse la limite de ${MAX_ABONNES_SCRAP} lignes.`);
    }

    let supprimees = 0;
    for (const existant of existants) {
      if (existant.licence && !licencesRecues.has(existant.licence)) {
        await ctx.db.delete(existant._id);
        supprimees++;
      }
    }
    return supprimees;
  },
});

// Traduction de la colonne « Autonomie » du club → etape_test_autonomie.
function testAutonomieDepuisScrap(
  autonomie?: string,
): "non_requis" | "requis" | "valide" | undefined {
  switch (autonomie) {
    case "OK":
      return "valide";
    case "Trop jeune":
      return "non_requis";
    case "Doit passer le test":
    case "Recherche du test en cours":
      return "requis";
    default:
      return undefined;
  }
}

// Projection unique du snapshot local du site vers les champs matérialisés
// d'une personne. `etape_paiement` reste pilotée par HelloAsso et n'est donc
// incluse que lorsque l'appelant a effectué ce rapprochement séparément.
export function champsPersonneDepuisScrap(
  scrap: Doc<"abo_abonnes_scrap">,
  etapePaiement?: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    age: scrap.age,
    etape_licence: scrap.adhesion === "OK",
    etape_inscription_site: true,
    etape_photo: scrap.photo === "OK",
    etape_abonnement_valide: abonnementEstValide(scrap.abonnement_valide),
    etape_test_autonomie: testAutonomieDepuisScrap(scrap.autonomie),
  };
  if (etapePaiement !== undefined) patch.etape_paiement = etapePaiement;
  return patch;
}

// ── matcherScrapPersonnes : met à jour les etape_* des personnes ─────────
// Un seul balayage borné. Renvoie le nombre de personnes mises à jour.
export const matcherScrapPersonnes = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const personnes = await ctx.db.query("abo_personnes").collect();
    const scrap = await ctx.db.query("abo_abonnes_scrap").collect();

    // Index licence → ligne scrap (licence unique dans abo_abonnes_scrap).
    const parLicence = new Map<string, (typeof scrap)[number]>();
    // Comptage nom_prenom_normalise pour ne garder que les noms NON ambigus.
    const compteNom = new Map<string, number>();
    for (const s of scrap) {
      if (s.licence) parLicence.set(s.licence, s);
      const clé = s.nom_prenom_normalise;
      if (clé) compteNom.set(clé, (compteNom.get(clé) ?? 0) + 1);
    }
    const parNomUnique = new Map<string, (typeof scrap)[number]>();
    for (const s of scrap) {
      const clé = s.nom_prenom_normalise;
      if (clé && compteNom.get(clé) === 1) parNomUnique.set(clé, s);
    }

    // Identités « payées » (HelloAsso, formulaire abo) : nom_prenom_normalise
    // de l'inscrit ET du payeur, hors commandes intégralement remboursées.
    const payes = new Set<string>();
    const cible = await trouverLienAbo(ctx);
    if (cible?.link) {
      const dossiers = await ctx.db
        .query("dossiers")
        .withIndex("by_link", (q) => q.eq("helloasso_link_id", cible.link!._id))
        .collect();
      for (const d of dossiers) {
        const txs = await ctx.db
          .query("helloasso_transactions")
          .withIndex("by_dossier", (q) => q.eq("dossier_id", d.dossier_id))
          .collect();
        const principales = txs.filter((t) => !estRemboursement(t));
        const totalRemb = txs
          .filter(estRemboursement)
          .reduce((s, t) => s + Math.abs(t.amount), 0);
        const totalPaye = principales.reduce((s, t) => s + t.amount, 0);
        // Payé si au moins une transaction non-remboursée subsiste (net > 0).
        if (principales.length === 0 || totalPaye - totalRemb <= 0) continue;
        payes.add(normaliserNomPrenom(d.last_name, d.first_name));
        payes.add(normaliserNomPrenom(d.payer_last_name, d.payer_first_name));
      }
    }

    let maj = 0;
    for (const p of personnes) {
      // Passe 1 (licence) puis passe 2 (nom/prénom unique, personnes sans licence).
      let s: (typeof scrap)[number] | undefined;
      let licenceResolue: string | undefined;
      if (p.licence) {
        s = parLicence.get(p.licence);
      } else {
        s = parNomUnique.get(p.nom_prenom_normalise);
        if (s?.licence) licenceResolue = s.licence;
      }

      const etapePaiement = payes.has(p.nom_prenom_normalise);
      if (!s) {
        // La ligne était auparavant matérialisée depuis le site du club mais
        // elle n'est plus présente dans le snapshot complet : on conserve la
        // demande du portail, tout en retirant ses confirmations site. Le
        // paiement reste une source HelloAsso indépendante du scrap.
        const patchSansScrap = {
          age: undefined,
          etape_licence: false,
          etape_test_autonomie: undefined,
          etape_inscription_site: false,
          etape_photo: false,
          etape_paiement: etapePaiement,
          etape_abonnement_valide: false,
        };
        if (champsModifies(p, patchSansScrap)) {
          await ctx.db.patch(p._id, patchSansScrap);
          maj++;
        }
        continue;
      }

      const patch = champsPersonneDepuisScrap(s, etapePaiement);
      if (licenceResolue) {
        patch.licence = licenceResolue;
        patch.licence_statut = "annuaire_auto";
      }
      // Patch seulement si au moins une étape/valeur change réellement : évite
      // de réécrire toutes les personnes matchées à chaque scrap (write + read
      // amplification sur abo_personnes, table lue par plusieurs tuiles).
      if (champsModifies(p, patch)) {
        await ctx.db.patch(p._id, patch);
        maj++;
      }

      // Après un scrap effectivement réussi, seule la ligne trouvée par la
      // licence exacte peut confirmer ou invalider une réservation provisoire.
      // Aucun rapprochement nom/prénom ne suffit pour annuler un rendez-vous.
      if (!p.licence || s.licence !== p.licence) continue;
      const autonomie = testAutonomieDepuisScrap(s.autonomie);
      const age = s.age;
      if (autonomie === undefined || age === undefined) continue;
      const reservations = await ctx.db
        .query("abo_test_reservations")
        .withIndex("by_personne", (q) => q.eq("personne_id", p._id))
        .collect();
      for (const reservation of reservations) {
        if (reservation.statut !== "active") continue;
        if (autonomie === "requis" && age >= 16) {
          if (reservation.etat_confirmation !== "confirmee") {
            await ctx.db.patch(reservation._id, { etat_confirmation: "confirmee" });
          }
          continue;
        }
        await ctx.db.patch(reservation._id, {
          statut: "annulee",
          annulee_le: new Date().toISOString(),
          annulee_raison: "conditions_test_non_remplies",
        });
        await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerAnnulationConditionsTest, {
          reservationId: reservation._id,
        });
      }
    }

    return maj;
  },
});
