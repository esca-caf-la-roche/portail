import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { authenticatedQuery } from "../customFunctions";
import {
  lireBorne,
  MAX_SAMEDIS_PAR_SAISON,
  requireGestionnaire,
  requireParticipant,
  verifierSaison,
} from "./lib";

const configurationValidator = v.union(
  v.null(),
  v.object({
    dateDebut: v.string(),
    dateFin: v.string(),
    derniereSynchronisation: v.union(v.null(), v.number()),
    statutSynchronisation: v.union(v.null(), v.literal("ok"), v.literal("erreur")),
    erreurSynchronisation: v.union(v.null(), v.string()),
  }),
);

const sourceBlocageValidator = v.union(
  v.literal("ferie"),
  v.literal("vacances"),
  v.literal("manuel"),
);

const creneauValidator = v.object({
  _id: v.id("samedis_creneaux"),
  date: v.string(),
  estBloque: v.boolean(),
  motifsBlocage: v.array(v.string()),
  sourcesBlocage: v.array(sourceBlocageValidator),
  blocageManuel: v.boolean(),
  blocageOfficiel: v.boolean(),
  ouvertureManuelle: v.boolean(),
  motifBlocageManuel: v.union(v.null(), v.string()),
  reservation: v.union(
    v.null(),
    v.object({
      _id: v.id("samedis_reservations"),
      participantId: v.id("samedis_participants"),
      participantNom: v.string(),
      forcee: v.boolean(),
      estLaMienne: v.boolean(),
      aRegulariser: v.boolean(),
    }),
  ),
});

const creneauParticipantValidator = v.object({
  _id: v.id("samedis_creneaux"),
  date: v.string(),
  estBloque: v.boolean(),
  motifsBlocage: v.array(v.string()),
  sourcesBlocage: v.array(sourceBlocageValidator),
  reservation: v.union(
    v.null(),
    v.object({
      occupee: v.literal(true),
      estLaMienne: v.literal(false),
    }),
    v.object({
      occupee: v.literal(true),
      estLaMienne: v.literal(true),
      reservationId: v.id("samedis_reservations"),
      participantId: v.id("samedis_participants"),
    }),
  ),
});

const compteurValidator = v.object({
  participantId: v.id("samedis_participants"),
  nom: v.string(),
  nombreReservations: v.number(),
});

async function chargerCalendrier(
  ctx: Parameters<typeof requireGestionnaire>[0],
  saison: string,
  options?: {
    participantCourant?: Id<"samedis_participants">;
    hydraterParticipants?: boolean;
  },
) {
  const configuration = await ctx.db
    .query("samedis_configurations")
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .unique();
  const creneaux = await lireBorne(
    ctx.db
      .query("samedis_creneaux")
      .withIndex("by_saison_and_date", (q) => q.eq("saison", saison))
      .order("asc")
      .take(MAX_SAMEDIS_PAR_SAISON + 1),
    MAX_SAMEDIS_PAR_SAISON,
    "La saison contient trop de samedis.",
  );
  const reservations = await lireBorne(
    ctx.db
      .query("samedis_reservations")
      .withIndex("by_saison", (q) => q.eq("saison", saison))
      .take(MAX_SAMEDIS_PAR_SAISON + 1),
    MAX_SAMEDIS_PAR_SAISON,
    "La saison contient trop de réservations.",
  );
  const participants = new Map<
    Id<"samedis_participants">,
    Doc<"samedis_participants"> | null
  >();
  if (options?.hydraterParticipants) {
    for (const reservation of reservations) {
      if (!participants.has(reservation.participantId)) {
        participants.set(reservation.participantId, await ctx.db.get(reservation.participantId));
      }
    }
  }
  const parCreneau = new Map(reservations.map((reservation) => [reservation.creneauId, reservation]));
  return {
    configuration: configuration
      ? {
          dateDebut: configuration.dateDebut,
          dateFin: configuration.dateFin,
          derniereSynchronisation: configuration.derniereSynchronisation ?? null,
          statutSynchronisation: configuration.statutSynchronisation ?? null,
          erreurSynchronisation: configuration.erreurSynchronisation ?? null,
        }
      : null,
    creneaux: creneaux.map((creneau) => {
      const reservation = parCreneau.get(creneau._id);
      const participant = reservation ? participants.get(reservation.participantId) : null;
      return {
        _id: creneau._id,
        date: creneau.date,
        estBloque: creneau.estBloque,
        motifsBlocage: creneau.motifsBlocage,
        sourcesBlocage: creneau.sourcesBlocage,
        blocageManuel: creneau.sourcesBlocage.includes("manuel"),
        blocageOfficiel: creneau.sourcesBlocage.some((source) => source !== "manuel"),
        ouvertureManuelle: creneau.ouvertureManuelle === true,
        motifBlocageManuel:
          creneau.motifsBlocage.find(
            (_motif, index) => creneau.sourcesBlocage[index] === "manuel",
          ) ?? null,
        reservation: reservation
          ? {
              _id: reservation._id,
              participantId: reservation.participantId,
              participantNom: participant?.nom ?? "Participant inconnu",
              forcee: reservation.forcee,
              estLaMienne: reservation.participantId === options?.participantCourant,
              aRegulariser: creneau.estBloque && !reservation.forcee,
            }
          : null,
      };
    }),
    reservations,
    participants,
  };
}

export const forManager = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.object({
    configuration: configurationValidator,
    creneaux: v.array(creneauValidator),
    compteurs: v.array(compteurValidator),
  }),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    const calendrier = await chargerCalendrier(ctx, saison, {
      hydraterParticipants: true,
    });
    const nombres = new Map<Id<"samedis_participants">, number>();
    for (const reservation of calendrier.reservations) {
      nombres.set(reservation.participantId, (nombres.get(reservation.participantId) ?? 0) + 1);
    }
    return {
      configuration: calendrier.configuration,
      creneaux: calendrier.creneaux,
      compteurs: [...nombres.entries()]
        .map(([participantId, nombreReservations]) => {
          const participant = calendrier.participants.get(participantId);
          return participant
            ? { participantId, nom: participant.nom, nombreReservations }
            : null;
        })
        .filter((compteur) => compteur !== null)
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
    };
  },
});

export const forParticipant = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.object({
    configuration: configurationValidator,
    creneaux: v.array(creneauParticipantValidator),
    nombreReservations: v.number(),
  }),
  handler: async (ctx, args) => {
    const participant = await requireParticipant(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    const calendrier = await chargerCalendrier(ctx, saison, {
      participantCourant: participant._id,
      hydraterParticipants: false,
    });
    return {
      configuration: calendrier.configuration,
      // Un participant voit qu'un créneau est occupé mais pas l'identité d'un tiers.
      creneaux: calendrier.creneaux.map((creneau) => ({
        _id: creneau._id,
        date: creneau.date,
        estBloque: creneau.estBloque,
        motifsBlocage: creneau.motifsBlocage,
        sourcesBlocage: creneau.sourcesBlocage,
        reservation: !creneau.reservation
          ? null
          : creneau.reservation.estLaMienne
            ? {
                occupee: true as const,
                estLaMienne: true as const,
                reservationId: creneau.reservation._id,
                participantId: creneau.reservation.participantId,
              }
            : {
                occupee: true as const,
                estLaMienne: false as const,
              },
      })),
      nombreReservations: calendrier.reservations.filter(
        (reservation) => reservation.participantId === participant._id,
      ).length,
    };
  },
});
