import { v } from "convex/values";
import { authenticatedMutation } from "../customFunctions";
import { champsModifies } from "../dbUtils";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  erreur,
  requireGestionnaire,
  requireParticipant,
  verifierSaison,
} from "./lib";
import { creerNotification } from "./notifications";

async function verifierCreneauLibre(
  ctx: QueryCtx | MutationCtx,
  creneauId: Id<"samedis_creneaux">,
  saison: string,
) {
  const creneau = await ctx.db.get(creneauId);
  if (!creneau || creneau.saison !== saison) {
    throw erreur("SAMEDIS_CRENEAU_ABSENT", "Samedi introuvable pour cette saison.");
  }
  const existante = await ctx.db
    .query("samedis_reservations")
    .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
    .unique();
  if (existante) throw erreur("SAMEDIS_DEJA_RESERVE", "Ce samedi est déjà réservé.");
  return creneau;
}

async function verifierCalendrierSynchronise(
  ctx: QueryCtx | MutationCtx,
  saison: string,
) {
  const configuration = await ctx.db
    .query("samedis_configurations")
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .unique();
  if (!configuration || configuration.statutSynchronisation !== "ok") {
    throw erreur(
      "SAMEDIS_CALENDRIER_NON_SYNCHRONISE",
      "Les inscriptions ouvriront après la synchronisation du calendrier officiel.",
    );
  }
}

export const reserver = authenticatedMutation({
  args: { saison: v.string(), creneauId: v.id("samedis_creneaux") },
  returns: v.id("samedis_reservations"),
  handler: async (ctx, args) => {
    const participant = await requireParticipant(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    await verifierCalendrierSynchronise(ctx, saison);
    const creneau = await verifierCreneauLibre(ctx, args.creneauId, saison);
    if (creneau.estBloque) {
      throw erreur("SAMEDIS_CRENEAU_BLOQUE", "Ce samedi est bloqué et ne peut pas être réservé.");
    }
    const reservationId = await ctx.db.insert("samedis_reservations", {
      saison,
      creneauId: creneau._id,
      participantId: participant._id,
      createdBy: ctx.userId,
      mode: "participant",
      forcee: false,
      createdAt: Date.now(),
    });
    await creerNotification(ctx, {
      saison,
      typeModification: "reservation_creee",
      acteurUserId: ctx.userId,
      resume: `${participant.nom} a réservé le ${creneau.date}.`,
    });
    return reservationId;
  },
});

export const reserverCommeGestionnaire = authenticatedMutation({
  args: {
    saison: v.string(),
    creneauId: v.id("samedis_creneaux"),
    participantId: v.id("samedis_participants"),
    forcer: v.boolean(),
  },
  returns: v.id("samedis_reservations"),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    await verifierCalendrierSynchronise(ctx, saison);
    const creneau = await verifierCreneauLibre(ctx, args.creneauId, saison);
    const participant = await ctx.db.get(args.participantId);
    if (!participant?.actif) throw erreur("SAMEDIS_PARTICIPANT_ABSENT", "Participant actif introuvable.");
    if (creneau.estBloque && !args.forcer) {
      throw erreur("SAMEDIS_CRENEAU_BLOQUE", "Ce samedi est bloqué. Utilisez l'inscription forcée.");
    }
    const forcee = creneau.estBloque;
    const reservationId = await ctx.db.insert("samedis_reservations", {
      saison,
      creneauId: creneau._id,
      participantId: participant._id,
      createdBy: ctx.userId,
      mode: "gestionnaire",
      forcee,
      createdAt: Date.now(),
    });
    await creerNotification(ctx, {
      saison,
      typeModification: "reservation_creee",
      acteurUserId: ctx.userId,
      resume: `${participant.nom} inscrit par un gestionnaire le ${creneau.date}${forcee ? " (inscription forcée)" : ""}.`,
    });
    return reservationId;
  },
});

export const annuler = authenticatedMutation({
  args: { reservationId: v.id("samedis_reservations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const participant = await requireParticipant(ctx, ctx.userId);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || reservation.participantId !== participant._id) {
      throw erreur("SAMEDIS_RESERVATION_ABSENTE", "Réservation introuvable.");
    }
    const creneau = await ctx.db.get(reservation.creneauId);
    await ctx.db.delete(reservation._id);
    await creerNotification(ctx, {
      saison: reservation.saison,
      typeModification: "reservation_annulee",
      acteurUserId: ctx.userId,
      resume: `${participant.nom} a annulé sa réservation du ${creneau?.date ?? "samedi inconnu"}.`,
    });
    return null;
  },
});

export const annulerCommeGestionnaire = authenticatedMutation({
  args: { reservationId: v.id("samedis_reservations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) throw erreur("SAMEDIS_RESERVATION_ABSENTE", "Réservation introuvable.");
    const [creneau, participant] = await Promise.all([
      ctx.db.get(reservation.creneauId),
      ctx.db.get(reservation.participantId),
    ]);
    await ctx.db.delete(reservation._id);
    await creerNotification(ctx, {
      saison: reservation.saison,
      typeModification: "reservation_annulee",
      acteurUserId: ctx.userId,
      resume: `Réservation de ${participant?.nom ?? "participant inconnu"} annulée par un gestionnaire pour le ${creneau?.date ?? "samedi inconnu"}.`,
    });
    return null;
  },
});

export const regulariserReservation = authenticatedMutation({
  args: { reservationId: v.id("samedis_reservations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) throw erreur("SAMEDIS_RESERVATION_ABSENTE", "Réservation introuvable.");
    const creneau = await ctx.db.get(reservation.creneauId);
    if (!creneau) throw erreur("SAMEDIS_CRENEAU_ABSENT", "Samedi introuvable.");
    if (!creneau.estBloque) {
      throw erreur(
        "SAMEDIS_REGULARISATION_INUTILE",
        "Cette réservation n'est pas située sur un samedi bloqué.",
      );
    }
    const patch = { forcee: true };
    if (champsModifies(reservation, patch)) {
      // createdBy et mode décrivent la création historique et sont conservés.
      await ctx.db.patch(reservation._id, patch);
      const participant = await ctx.db.get(reservation.participantId);
      await creerNotification(ctx, {
        saison: reservation.saison,
        typeModification: "reservation_regularisee",
        acteurUserId: ctx.userId,
        resume: `Réservation de ${participant?.nom ?? "participant inconnu"} régularisée pour le ${creneau.date}.`,
      });
    }
    return null;
  },
});
