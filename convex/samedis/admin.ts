import { v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { champsModifies } from "../dbUtils";
import { canoniserEmailUnique } from "../emailValidation";
import {
  enumererSamedis,
  erreur,
  lireBorne,
  MAX_PARTICIPANTS,
  MAX_SAMEDIS_PAR_SAISON,
  requireGestionnaire,
  tableauxEgaux,
  texteCourt,
  verifierSaison,
} from "./lib";
import { creerNotification } from "./notifications";

const participantValidator = v.object({
  _id: v.id("samedis_participants"),
  nom: v.string(),
  email: v.string(),
  actif: v.boolean(),
  connecte: v.boolean(),
});

export const listParticipants = authenticatedQuery({
  args: {},
  returns: v.array(participantValidator),
  handler: async (ctx) => {
    await requireGestionnaire(ctx, ctx.userId);
    // IO-BOUNDED: l'annuaire de la tuile est limité métier à 500 personnes.
    const participants = await lireBorne(
      ctx.db.query("samedis_participants").take(MAX_PARTICIPANTS + 1),
      MAX_PARTICIPANTS,
      "L'annuaire dépasse 500 participants.",
    );
    return participants
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr"))
      .map((participant) => ({
        _id: participant._id,
        nom: participant.nom,
        email: participant.email,
        actif: participant.actif,
        connecte: participant.userId !== undefined,
      }));
  },
});

export const upsertConfiguration = authenticatedMutation({
  args: {
    saison: v.string(),
    dateDebut: v.string(),
    dateFin: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    const dates = enumererSamedis(args.dateDebut, args.dateFin);
    const existante = await ctx.db
      .query("samedis_configurations")
      .withIndex("by_saison", (q) => q.eq("saison", saison))
      .unique();
    // Champ historique conservé pour compatibilité avec les données déjà
    // créées. Le lieu n'est plus une donnée configurable ni exposée à l'UI.
    const lieuInterne = existante?.lieuParDefaut ?? "Filière Grimpe";
    const creneaux = await lireBorne(
      ctx.db
        .query("samedis_creneaux")
        .withIndex("by_saison", (q) => q.eq("saison", saison))
        .take(MAX_SAMEDIS_PAR_SAISON + 1),
      MAX_SAMEDIS_PAR_SAISON,
      "La saison contient trop de samedis.",
    );
    const datesAttendues = new Set(dates);
    for (const creneau of creneaux) {
      if (datesAttendues.has(creneau.date)) continue;
      const reservation = await ctx.db
        .query("samedis_reservations")
        .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
        .unique();
      if (reservation) {
        throw erreur(
          "SAMEDIS_PERIODE_RESERVEE",
          `La période exclut le ${creneau.date}, qui est déjà réservé. Annulez d'abord cette réservation.`,
        );
      }
    }

    const now = Date.now();
    const configuration = {
      saison,
      dateDebut: args.dateDebut,
      dateFin: args.dateFin,
      lieuParDefaut: lieuInterne,
      academie: "Grenoble" as const,
      zone: "A" as const,
      updatedAt: now,
      updatedBy: ctx.userId,
    };
    const parametresModifies = !existante || champsModifies(
      existante,
      configuration,
      ["updatedAt", "updatedBy"],
    );
    let modificationEffectuee = false;
    if (!existante) {
      await ctx.db.insert("samedis_configurations", configuration);
      modificationEffectuee = true;
    } else if (parametresModifies) {
      await ctx.db.patch(existante._id, {
        ...configuration,
        // Les résultats officiels correspondent aux anciennes bornes : la
        // prochaine synchro doit pouvoir partir immédiatement.
        derniereSynchronisation: undefined,
        statutSynchronisation: undefined,
        erreurSynchronisation: undefined,
      });
      modificationEffectuee = true;
    }

    const parDate = new Map(creneaux.map((creneau) => [creneau.date, creneau]));
    for (const date of dates) {
      const creneauExistant = parDate.get(date);
      if (!creneauExistant) {
        await ctx.db.insert("samedis_creneaux", {
          saison,
          date,
          lieu: lieuInterne,
          estBloque: false,
          motifsBlocage: [],
          sourcesBlocage: [],
          updatedAt: now,
          updatedBy: ctx.userId,
        });
        modificationEffectuee = true;
      }
    }
    for (const creneau of creneaux) {
      if (!datesAttendues.has(creneau.date)) {
        await ctx.db.delete(creneau._id);
        modificationEffectuee = true;
      }
    }
    if (modificationEffectuee) {
      await creerNotification(ctx, {
        saison,
        typeModification: "configuration_modifiee",
        acteurUserId: ctx.userId,
        resume: `Période des samedis : ${args.dateDebut} au ${args.dateFin}.`,
      });
    }
    return null;
  },
});

export const addParticipant = authenticatedMutation({
  args: { nom: v.string(), email: v.string() },
  returns: v.id("samedis_participants"),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const nom = texteCourt(args.nom, "Le nom", 120);
    const email = canoniserEmailUnique(args.email);
    const salariePlanning = await ctx.db
      .query("planning_salaries_annuaire")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
      .unique();
    if (salariePlanning) {
      throw erreur(
        "SAMEDIS_EMAIL_AUTRE_ESPACE",
        "Cette adresse appartient déjà au planning salarié isolé.",
      );
    }
    const doublon = await ctx.db
      .query("samedis_participants")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
      .unique();
    if (doublon) throw erreur("SAMEDIS_EMAIL_EXISTANT", "Cette adresse est déjà enregistrée.");
    const total = await ctx.db.query("samedis_participants").take(MAX_PARTICIPANTS + 1);
    if (total.length >= MAX_PARTICIPANTS) {
      throw erreur("SAMEDIS_PARTICIPANTS_MAX", "L'annuaire est limité à 500 participants.");
    }
    const now = Date.now();
    const participantId = await ctx.db.insert("samedis_participants", {
      nom,
      email,
      emailNormalise: email,
      actif: true,
      createdAt: now,
      updatedAt: now,
    });
    await creerNotification(ctx, {
      typeModification: "participant_ajoute",
      acteurUserId: ctx.userId,
      resume: `Participant ajouté : ${nom} <${email}>.`,
    });
    return participantId;
  },
});

export const updateParticipant = authenticatedMutation({
  args: {
    participantId: v.id("samedis_participants"),
    nom: v.string(),
    email: v.string(),
    actif: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const participant = await ctx.db.get(args.participantId);
    if (!participant) throw erreur("SAMEDIS_PARTICIPANT_ABSENT", "Participant introuvable.");
    const nom = texteCourt(args.nom, "Le nom", 120);
    const email = canoniserEmailUnique(args.email);
    const salariePlanning = await ctx.db
      .query("planning_salaries_annuaire")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
      .unique();
    if (salariePlanning) {
      throw erreur(
        "SAMEDIS_EMAIL_AUTRE_ESPACE",
        "Cette adresse appartient déjà au planning salarié isolé.",
      );
    }
    const doublon = await ctx.db
      .query("samedis_participants")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
      .unique();
    if (doublon && doublon._id !== participant._id) {
      throw erreur("SAMEDIS_EMAIL_EXISTANT", "Cette adresse est déjà enregistrée.");
    }
    const emailChange = email !== participant.emailNormalise;
    const patch = {
      nom,
      email,
      emailNormalise: email,
      actif: args.actif,
      ...(emailChange ? { userId: undefined } : {}),
      updatedAt: Date.now(),
    };
    if (champsModifies(participant, patch, ["updatedAt"])) {
      await ctx.db.patch(participant._id, patch);
      await creerNotification(ctx, {
        typeModification: "participant_modifie",
        acteurUserId: ctx.userId,
        resume: `Participant modifié : ${nom} <${email}> (${args.actif ? "actif" : "désactivé"}).`,
      });
    }
    return null;
  },
});

export const removeParticipant = authenticatedMutation({
  args: { participantId: v.id("samedis_participants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const participant = await ctx.db.get(args.participantId);
    if (!participant) {
      throw erreur("SAMEDIS_PARTICIPANT_ABSENT", "Participant introuvable.");
    }
    const reservation = await ctx.db
      .query("samedis_reservations")
      .withIndex("by_participantId", (q) => q.eq("participantId", participant._id))
      .first();
    if (reservation) {
      throw erreur(
        "SAMEDIS_PARTICIPANT_RESERVE",
        `Ce participant possède une réservation en saison ${reservation.saison}. Annulez toutes ses réservations avant de le supprimer.`,
      );
    }
    await ctx.db.delete(participant._id);
    await creerNotification(ctx, {
      typeModification: "participant_supprime",
      acteurUserId: ctx.userId,
      resume: `Participant supprimé : ${participant.nom} <${participant.email}>.`,
    });
    return null;
  },
});

export const updateCreneau = authenticatedMutation({
  args: {
    creneauId: v.id("samedis_creneaux"),
    bloqueManuellement: v.boolean(),
    motif: v.optional(v.string()),
    ouvertureManuelle: v.optional(v.boolean()),
    commentaireBlocage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const creneau = await ctx.db.get(args.creneauId);
    if (!creneau) throw erreur("SAMEDIS_CRENEAU_ABSENT", "Samedi introuvable.");
    const motifManuel = args.bloqueManuellement
      ? texteCourt(args.motif ?? "", "Le motif de blocage", 200)
      : null;
    const motifsOfficiels = creneau.motifsBlocage.filter(
      (_motif, index) => creneau.sourcesBlocage[index] !== "manuel",
    );
    const sourcesOfficielles = creneau.sourcesBlocage.filter((source) => source !== "manuel");
    const blocageOfficiel = sourcesOfficielles.length > 0;
    const commentaireBlocage = args.commentaireBlocage === undefined
      ? undefined
      : args.commentaireBlocage.trim();
    if (commentaireBlocage !== undefined && commentaireBlocage.length > 500) {
      throw erreur(
        "SAMEDIS_COMMENTAIRE_BLOCAGE_INVALIDE",
        "Le commentaire de blocage est limité à 500 caractères.",
      );
    }
    const commentaireBlocageNormalise = commentaireBlocage || undefined;
    const commentaireBlocageExistant = creneau.commentaireBlocage?.trim() || undefined;
    if (
      commentaireBlocageNormalise !== undefined &&
      commentaireBlocageExistant === undefined &&
      !blocageOfficiel
    ) {
      throw erreur(
        "SAMEDIS_COMMENTAIRE_SANS_BLOCAGE_OFFICIEL",
        "Un commentaire de blocage peut seulement être créé sur un samedi bloqué par le calendrier officiel.",
      );
    }
    const ouvertureManuelle =
      args.ouvertureManuelle ?? (creneau.ouvertureManuelle === true);
    if (ouvertureManuelle && !blocageOfficiel) {
      throw erreur(
        "SAMEDIS_OUVERTURE_SANS_BLOCAGE_OFFICIEL",
        "Cette disponibilité exceptionnelle est réservée aux samedis bloqués par le calendrier officiel.",
      );
    }
    if (ouvertureManuelle && args.bloqueManuellement) {
      throw erreur(
        "SAMEDIS_OUVERTURE_ET_BLOCAGE_INCOMPATIBLES",
        "Un samedi ne peut pas être à la fois bloqué manuellement et rendu disponible.",
      );
    }
    const nouveauxMotifs = motifManuel ? [...motifsOfficiels, motifManuel] : motifsOfficiels;
    const nouvellesSources = args.bloqueManuellement
      ? [...sourcesOfficielles, "manuel" as const]
      : sourcesOfficielles;
    const estBloque =
      args.bloqueManuellement || (blocageOfficiel && !ouvertureManuelle);
    const etatMetier = {
      estBloque,
      ouvertureManuelle: ouvertureManuelle ? true : undefined,
      ...(args.commentaireBlocage === undefined
        ? {}
        : { commentaireBlocage: commentaireBlocageNormalise }),
      motifsBlocage: tableauxEgaux(creneau.motifsBlocage, nouveauxMotifs)
        ? creneau.motifsBlocage
        : nouveauxMotifs,
      sourcesBlocage: tableauxEgaux(creneau.sourcesBlocage, nouvellesSources)
        ? creneau.sourcesBlocage
        : nouvellesSources,
    };
    if (!champsModifies(creneau, etatMetier)) return null;

    const reservation = await ctx.db
      .query("samedis_reservations")
      .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
      .unique();
    if (args.bloqueManuellement && reservation && !reservation.forcee) {
      throw erreur(
        "SAMEDIS_RESERVATION_A_REGULARISER",
        "Ce samedi est déjà réservé. Annulez la réservation ou régularisez-la comme inscription forcée avant d'ajouter ce blocage.",
      );
    }
    if (estBloque && !creneau.estBloque && reservation && !reservation.forcee) {
      throw erreur(
        "SAMEDIS_RESERVATION_A_REGULARISER",
        "Ce samedi est déjà réservé. Annulez la réservation ou régularisez-la comme inscription forcée avant de rétablir ce blocage.",
      );
    }

    const patch = {
      ...etatMetier,
      modificationManuelle: true,
      updatedAt: Date.now(),
      updatedBy: ctx.userId,
    };
    await ctx.db.patch(creneau._id, patch);
    const changements: string[] = [];
    if (motifManuel) {
      const motifManuelExistant = creneau.motifsBlocage.find(
        (_motif, index) => creneau.sourcesBlocage[index] === "manuel",
      );
      if (motifManuel !== motifManuelExistant) changements.push(`bloqué : ${motifManuel}`);
    } else if (creneau.sourcesBlocage.includes("manuel")) {
      changements.push("blocage manuel retiré");
    }
    if (ouvertureManuelle && creneau.ouvertureManuelle !== true) {
      changements.push("rendu disponible malgré le blocage officiel");
    } else if (!ouvertureManuelle && creneau.ouvertureManuelle === true) {
      changements.push("disponibilité exceptionnelle retirée");
    }
    if (
      args.commentaireBlocage !== undefined &&
      commentaireBlocageNormalise !== commentaireBlocageExistant
    ) {
      changements.push(
        commentaireBlocageNormalise
          ? "commentaire interne de blocage mis à jour"
          : "commentaire interne de blocage supprimé",
      );
    }
    await creerNotification(ctx, {
      saison: creneau.saison,
      typeModification: "creneau_modifie",
      acteurUserId: ctx.userId,
      resume: `${creneau.date} — ${changements.join(" ; ")}.`,
    });
    return null;
  },
});
