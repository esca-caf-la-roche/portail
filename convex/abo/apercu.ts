// Prévisualisation strictement en lecture seule du suivi tel que le voit
// l'abonné. Cette query ne crée aucune session abonné, ne marque aucun message
// comme lu et ne déclenche aucune notification.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { authenticatedQuery } from "../customFunctions";
import { requireAboAdmin } from "./auth";
import { liensFinalisationVue, vagueCourante } from "./config";
import { calculerSuiviPersonnes, personneVue } from "./demandes";

const MAX_PERSONNES_PAR_DOSSIER = 10;
const MAX_RESERVATIONS_PAR_PERSONNE = 100;
const MAX_MESSAGES_APERCU = 200;

const statutDossierValidator = v.union(
  v.literal("nouvelle_demande"),
  v.literal("validee"),
  v.literal("liste_attente"),
  v.literal("refusee"),
  v.literal("complete"),
);

const personneValidator = v.object({
  id: v.id("abo_personnes"),
  nom: v.string(),
  prenom: v.string(),
  age: v.union(v.number(), v.null()),
  nom_prenom_normalise: v.string(),
  licence: v.union(v.string(), v.null()),
  licence_statut: v.union(
    v.literal("saisie"),
    v.literal("annuaire_auto"),
    v.literal("annuaire_valide"),
    v.literal("inconnu"),
  ),
  etape_demande: v.boolean(),
  etape_validation: v.union(
    v.literal("en_attente"),
    v.literal("validee"),
    v.literal("liste_attente"),
    v.literal("refusee"),
  ),
  etape_licence: v.boolean(),
  etape_test_autonomie: v.union(
    v.literal("non_requis"),
    v.literal("requis"),
    v.literal("valide"),
    v.null(),
  ),
  etape_inscription_site: v.boolean(),
  etape_photo: v.boolean(),
  etape_paiement: v.boolean(),
  etape_abonnement_valide: v.boolean(),
  vague_depot: v.union(
    v.literal("vague_2"),
    v.literal("vague_3"),
    v.literal("historique"),
  ),
  deposee_le: v.string(),
});

const suiviValidator = v.object({
  personne_id: v.id("abo_personnes"),
  licence_ok: v.boolean(),
  inscription_ok: v.boolean(),
  paiement_ok: v.boolean(),
  test_autonomie: v.union(
    v.literal("valide"),
    v.literal("non_requis"),
    v.literal("requis"),
    v.null(),
  ),
  reglement_signe: v.boolean(),
  age: v.union(v.number(), v.null()),
});

const reservationValidator = v.object({
  id: v.id("abo_test_reservations"),
  tranche: v.string(),
  tranche_fin: v.union(v.string(), v.null()),
  statut: v.union(v.literal("active"), v.literal("annulee")),
  annulee_le: v.union(v.string(), v.null()),
  etat_confirmation: v.union(
    v.literal("provisoire"),
    v.literal("confirmee"),
  ),
  annulee_raison: v.union(
    v.literal("candidat"),
    v.literal("creneau_admin_annule"),
    v.literal("conditions_test_non_remplies"),
    v.null(),
  ),
});

const apercuValidator = v.object({
  lectureSeule: v.boolean(),
  vague: v.number(),
  dossier: v.object({
    id: v.id("abo_dossiers"),
    email: v.string(),
    statut_dossier: statutDossierValidator,
    commentaire: v.union(v.string(), v.null()),
    date_soumission: v.string(),
    personnes: v.array(personneValidator),
  }),
  checks: v.array(suiviValidator),
  reservations: v.array(v.object({
    personne_id: v.id("abo_personnes"),
    active: v.union(reservationValidator, v.null()),
    annulee: v.union(reservationValidator, v.null()),
  })),
  suivisDisponibilites: v.array(v.object({
    cle: v.string(),
    statut: v.union(
      v.literal("en_attente"),
      v.literal("reservee"),
      v.literal("desabonnee"),
      v.literal("ineligible"),
    ),
  })),
  messages: v.array(v.object({
    id: v.id("abo_messages"),
    auteur_role: v.union(v.literal("utilisateur"), v.literal("admin")),
    contenu: v.string(),
    created_at: v.number(),
    est_moi: v.boolean(),
    lu_par_admin: v.boolean(),
    lu_par_user: v.boolean(),
  })),
  messagesTronques: v.boolean(),
  liens: v.object({
    licence_nouvelle: v.union(v.string(), v.null()),
    licence_renouvellement: v.union(v.string(), v.null()),
    compte_activation: v.union(v.string(), v.null()),
    inscription: v.union(v.string(), v.null()),
    helloasso: v.union(v.string(), v.null()),
    test_autonomie: v.union(v.string(), v.null()),
    reglement: v.string(),
  }),
});

type ReservationVue = {
  id: Id<"abo_test_reservations">;
  tranche: string;
  tranche_fin: string | null;
  statut: "active" | "annulee";
  annulee_le: string | null;
  etat_confirmation: "provisoire" | "confirmee";
  annulee_raison:
    | "candidat"
    | "creneau_admin_annule"
    | "conditions_test_non_remplies"
    | null;
};

function reservationVue(r: Doc<"abo_test_reservations">): ReservationVue {
  return {
    id: r._id,
    tranche: r.tranche,
    tranche_fin: r.tranche_fin ?? null,
    statut: r.statut,
    annulee_le: r.annulee_le ?? null,
    etat_confirmation: r.etat_confirmation ?? "provisoire",
    annulee_raison: r.annulee_raison ?? null,
  };
}

// Bundle consommé par la vue admin : dossier, contrôles live, réservations,
// alertes, fil et liens. Le shape est volontairement proche des queries de la
// page Suivi afin que le front puisse partager ses composants de présentation.
export const get = authenticatedQuery({
  args: {
    dossierId: v.id("abo_dossiers"),
    maintenantMs: v.number(),
  },
  returns: apercuValidator,
  handler: async (ctx, args) => {
    // La garde précède volontairement toute lecture du dossier : un appelant
    // non autorisé ne peut pas tester l'existence d'un identifiant.
    await requireAboAdmin(ctx);

    const dossier = await ctx.db.get(args.dossierId);
    if (!dossier) {
      throw new ConvexError({
        code: "ABO_APERCU_DOSSIER_INTROUVABLE",
        message: "Dossier introuvable.",
      });
    }

    const personnesLues = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .take(MAX_PERSONNES_PAR_DOSSIER + 1);
    if (personnesLues.length > MAX_PERSONNES_PAR_DOSSIER) {
      throw new ConvexError({
        code: "ABO_APERCU_DOSSIER_INCOHERENT",
        message: "Ce dossier dépasse la limite de personnes autorisée.",
      });
    }
    const personnes = personnesLues;

    const reservations = [];
    const suivisDisponibilites = [];
    for (const personne of personnes) {
      const lignes = await ctx.db
        .query("abo_test_reservations")
        .withIndex("by_personne", (q) => q.eq("personne_id", personne._id))
        .order("desc")
        .take(MAX_RESERVATIONS_PAR_PERSONNE + 1);
      if (lignes.length > MAX_RESERVATIONS_PAR_PERSONNE) {
        throw new ConvexError({
          code: "ABO_APERCU_RESERVATIONS_TROP_NOMBREUSES",
          message: "Trop de réservations existent pour afficher un aperçu fiable.",
        });
      }
      const active = lignes.find((ligne) => ligne.statut === "active") ?? null;
      const annulee =
        lignes.find(
          (ligne) =>
            ligne.statut === "annulee" &&
            (ligne.annulee_raison === "creneau_admin_annule" ||
              ligne.annulee_raison === "conditions_test_non_remplies"),
        ) ?? null;
      if (active || annulee) {
        reservations.push({
          personne_id: personne._id,
          active: active ? reservationVue(active) : null,
          annulee: annulee ? reservationVue(annulee) : null,
        });
      }

      const cle = `dossier:${personne._id}`;
      const attente = await ctx.db
        .query("abo_test_attentes_notifications")
        .withIndex("by_user_id_and_cle_candidat", (q) =>
          q.eq("user_id", dossier.owner_id).eq("cle_candidat", cle),
        )
        .first();
      if (attente) {
        suivisDisponibilites.push({ cle, statut: attente.statut });
      }
    }

    const messagesLus = await ctx.db
      .query("abo_messages")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .order("desc")
      .take(MAX_MESSAGES_APERCU + 1);
    const messagesTronques = messagesLus.length > MAX_MESSAGES_APERCU;
    const messages = messagesLus
      .slice(0, MAX_MESSAGES_APERCU)
      .reverse()
      .map((message) => ({
        id: message._id,
        auteur_role: message.auteur_role,
        contenu: message.contenu,
        created_at: message._creationTime,
        // La projection exprime le côté de la conversation, pas l'identité du
        // staff connecté. Elle reste correcte après une fusion de dossiers.
        est_moi: message.auteur_role === "utilisateur",
        lu_par_admin: message.lu_par_admin,
        lu_par_user: message.lu_par_user,
      }));

    const [checks, liens, vague] = await Promise.all([
      calculerSuiviPersonnes(ctx, personnes),
      liensFinalisationVue(ctx),
      vagueCourante(ctx, args.maintenantMs),
    ]);

    return {
      lectureSeule: true,
      vague,
      dossier: {
        id: dossier._id,
        email: dossier.email,
        statut_dossier: dossier.statut_dossier,
        commentaire: dossier.commentaire ?? null,
        date_soumission: dossier.date_soumission,
        personnes: personnes.map(personneVue),
      },
      checks,
      reservations,
      suivisDisponibilites,
      messages,
      messagesTronques,
      liens,
    };
  },
});
