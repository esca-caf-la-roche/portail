import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { champsModifies } from "../dbUtils";
import {
  MAX_CRENEAUX_PAR_SAISON,
  MAX_OPERATIONS_PAR_SAISON,
  MAX_SALARIES,
  PLACEHOLDER_RESOURCE,
  bornesSaison,
  erreur,
} from "./lib";

const evenementValidator = v.object({
  date: v.string(),
  debut: v.string(),
  fin: v.string(),
  groupe: v.string(),
  titre: v.string(),
  googleCalendarId: v.string(),
  googleEventId: v.string(),
  googleICalUid: v.optional(v.string()),
  googleOccurrenceStart: v.string(),
  currentResourceCalendarId: v.string(),
  etag: v.optional(v.string()),
});

function dateParis(instant: number): string {
  const morceaux = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const valeur = Object.fromEntries(
    morceaux.map((morceau) => [morceau.type, morceau.value]),
  );
  return `${valeur.year}-${valeur.month}-${valeur.day}`;
}

export const contexteGoogle = internalQuery({
  args: {},
  returns: v.object({
    resources: v.array(v.object({
      salarieId: v.id("planning_salaries_annuaire"),
      resourceCalendarId: v.string(),
    })),
  }),
  handler: async (ctx) => ({
    resources: (await ctx.db.query("planning_salaries_annuaire")
      .take(MAX_SALARIES + 1))
      .map((s) => ({ salarieId: s._id, resourceCalendarId: s.resourceCalendarId })),
  }),
});

export const reserverSync = internalMutation({
  args: { saison: v.string(), maintenant: v.number(), forcer: v.boolean() },
  returns: v.object({ lancee: v.boolean(), startedAt: v.union(v.null(), v.number()) }),
  handler: async (ctx, args) => {
    const { saison } = bornesSaison(args.saison);
    const existant = await ctx.db.query("planning_salaries_sync")
      .withIndex("by_saison_and_cle", (q) => q.eq("saison", saison).eq("cle", "google_calendar")).unique();
    if (existant?.verrouJusqua && existant.verrouJusqua > args.maintenant) {
      return { lancee: false, startedAt: null };
    }
    if (!args.forcer && existant?.derniereSynchronisationAt && args.maintenant - existant.derniereSynchronisationAt < 60 * 60 * 1_000) {
      return { lancee: false, startedAt: null };
    }
    const patch = {
      saison,
      cle: "google_calendar" as const,
      statut: "en_cours" as const,
      verrouJusqua: args.maintenant + 10 * 60 * 1_000,
      derniereErreur: undefined,
      updatedAt: args.maintenant,
    };
    if (existant) await ctx.db.patch(existant._id, patch);
    else await ctx.db.insert("planning_salaries_sync", patch);
    return { lancee: true, startedAt: args.maintenant };
  },
});

export const appliquerSync = internalMutation({
  args: {
    saison: v.string(),
    startedAt: v.number(),
    acteurUserId: v.id("users"),
    evenements: v.array(evenementValidator),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { saison, dateDebut, dateFin } = bornesSaison(args.saison);
    if (args.evenements.length > MAX_CRENEAUX_PAR_SAISON) throw erreur("PLANNING_VOLUME", "Trop d'événements Google pour une saison.");
    const sync = await ctx.db.query("planning_salaries_sync")
      .withIndex("by_saison_and_cle", (q) => q.eq("saison", saison).eq("cle", "google_calendar")).unique();
    if (!sync || sync.updatedAt !== args.startedAt || sync.statut !== "en_cours") {
      throw erreur("PLANNING_SYNC_OBSOLETE", "Cette synchronisation a été remplacée.");
    }
    const [salaries, creneauxExistants, affectationsExistantes] = await Promise.all([
      ctx.db.query("planning_salaries_annuaire").take(MAX_SALARIES + 1),
      ctx.db.query("planning_salaries_creneaux")
        .withIndex("by_saison", (q) => q.eq("saison", saison))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.query("planning_salaries_affectations")
        .withIndex("by_saison", (q) => q.eq("saison", saison))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
    ]);
    if (
      salaries.length > MAX_SALARIES ||
      creneauxExistants.length > MAX_CRENEAUX_PAR_SAISON ||
      affectationsExistantes.length > MAX_CRENEAUX_PAR_SAISON
    ) {
      throw erreur("PLANNING_VOLUME", "Le planning dépasse les limites prévues.");
    }
    if (affectationsExistantes.some((affectation) => !affectation.date)) {
      throw erreur(
        "PLANNING_MIGRATION_REQUISE",
        "Les anciennes affectations doivent être migrées par samedi avant la synchronisation Google.",
      );
    }
    const parRessource = new Map(salaries.map((s) => [s.resourceCalendarIdNormalise, s]));
    const aujourdHui = dateParis(args.startedAt);
    const operationsLocales = await ctx.db.query("planning_salaries_google_operations")
      .withIndex("by_saison", (q) => q.eq("saison", saison))
      .take(MAX_OPERATIONS_PAR_SAISON + 1);
    if (operationsLocales.length > MAX_OPERATIONS_PAR_SAISON) {
      throw erreur("PLANNING_VOLUME", "Trop d'opérations Google pour cette saison.");
    }
    const creneauxAvecSaga = new Set(
      operationsLocales.filter((operation) => operation.statut !== "traitee").map((operation) => operation.creneauId),
    );
    const affectationParDate = new Map(
      affectationsExistantes
        .filter((affectation) => affectation.date !== undefined)
        .map((affectation) => [affectation.date!, affectation]),
    );
    const evenementsParDate = new Map<string, typeof args.evenements>();
    const creneauxParDate = new Map<
      string,
      Set<Id<"planning_salaries_creneaux">>
    >();
    const clesVues = new Set<string>();
    let modifications = 0;
    for (const event of args.evenements) {
      if (event.date < dateDebut || event.date > dateFin) continue;
      const cle = `${event.googleICalUid ?? event.googleEventId}\u0000${event.googleOccurrenceStart}`;
      clesVues.add(cle);
      evenementsParDate.set(event.date, [
        ...(evenementsParDate.get(event.date) ?? []),
        event,
      ]);
      const existant = event.googleICalUid
        ? await ctx.db.query("planning_salaries_creneaux")
          .withIndex("by_saison_and_googleICalUid_and_googleOccurrenceStart", (q) =>
            q.eq("saison", saison).eq("googleICalUid", event.googleICalUid).eq("googleOccurrenceStart", event.googleOccurrenceStart))
          .unique()
        : await ctx.db.query("planning_salaries_creneaux")
          .withIndex("by_saison_and_googleEventId_and_googleOccurrenceStart", (q) =>
            q.eq("saison", saison).eq("googleEventId", event.googleEventId).eq("googleOccurrenceStart", event.googleOccurrenceStart))
          .unique();
      const doc = { ...event, saison, syncedAt: args.startedAt, updatedAt: args.startedAt };
      const creneauId = existant?._id ?? await ctx.db.insert("planning_salaries_creneaux", doc);
      if (existant && champsModifies(existant, doc, ["syncedAt", "updatedAt"])) {
        await ctx.db.patch(existant._id, doc);
        modifications += 1;
      } else if (!existant) modifications += 1;
      const ids = creneauxParDate.get(event.date) ??
        new Set<Id<"planning_salaries_creneaux">>();
      ids.add(creneauId);
      creneauxParDate.set(event.date, ids);
    }

    // Une affectation porte sur la date entière. Google n'est repris comme
    // source que si tous les événements du samedi portent exactement la même
    // ressource. Un mélange reste « À déterminer » et pourra être réparé en un
    // clic, qui créera une opération pour chaque événement.
    for (const [date, evenements] of evenementsParDate) {
      const ids = creneauxParDate.get(date) ??
        new Set<Id<"planning_salaries_creneaux">>();
      if ([...ids].some((id) => creneauxAvecSaga.has(id))) continue;
      const ressources = new Set(
        evenements.map((event) => event.currentResourceCalendarId.toLowerCase()),
      );
      const ressourceUnique = ressources.size === 1 ? [...ressources][0] : null;
      const candidatGoogle = ressourceUnique
        ? parRessource.get(ressourceUnique)
        : undefined;
      const salarieGoogle = candidatGoogle &&
        (candidatGoogle.actif || date < aujourdHui)
        ? candidatGoogle
        : undefined;
      const affectation = affectationParDate.get(date);
      if (!affectation && salarieGoogle) {
        await ctx.db.insert("planning_salaries_affectations", {
          saison,
          date,
          salarieId: salarieGoogle._id,
          resourceCalendarIdSnapshot: salarieGoogle.resourceCalendarId,
          createdBy: args.acteurUserId,
          createdAt: args.startedAt,
          updatedBy: args.acteurUserId,
          updatedAt: args.startedAt,
        });
      } else if (affectation && salarieGoogle && affectation.salarieId !== salarieGoogle._id) {
        const patch = {
          salarieId: salarieGoogle._id,
          resourceCalendarIdSnapshot: salarieGoogle.resourceCalendarId,
          updatedBy: args.acteurUserId,
          updatedAt: args.startedAt,
        };
        if (champsModifies(affectation, patch, ["updatedAt"])) await ctx.db.patch(affectation._id, patch);
      } else if (
        affectation &&
        (!salarieGoogle || ressourceUnique === PLACEHOLDER_RESOURCE)
      ) {
        await ctx.db.delete(affectation._id);
        affectationParDate.delete(date);
      }
    }
    // Google Calendar est la source des groupes. Une occurrence disparue est
    // purgée avec son outbox. L'affectation du samedi n'est supprimée que si la
    // date entière ne contient plus aucun événement.
    for (const creneau of creneauxExistants) {
      const cle = `${creneau.googleICalUid ?? creneau.googleEventId}\u0000${creneau.googleOccurrenceStart}`;
      if (clesVues.has(cle)) continue;
      for (const operation of operationsLocales) {
        if (operation.creneauId === creneau._id) {
          await ctx.db.delete(operation._id);
        }
      }
      await ctx.db.delete(creneau._id);
      modifications += 1;
    }
    for (const affectation of affectationsExistantes) {
      if (affectation.date && !evenementsParDate.has(affectation.date)) {
        await ctx.db.delete(affectation._id);
      }
    }
    await ctx.db.patch(sync._id, {
      statut: "ok",
      verrouJusqua: undefined,
      derniereSynchronisationAt: args.startedAt,
      derniereErreur: undefined,
      updatedAt: Date.now(),
    });
    return modifications;
  },
});

export const marquerEchecSync = internalMutation({
  args: { saison: v.string(), startedAt: v.number(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sync = await ctx.db.query("planning_salaries_sync")
      .withIndex("by_saison_and_cle", (q) => q.eq("saison", args.saison).eq("cle", "google_calendar")).unique();
    if (sync?.statut === "en_cours" && sync.updatedAt === args.startedAt) {
      await ctx.db.patch(sync._id, { statut: "erreur", verrouJusqua: undefined, derniereErreur: args.message.slice(0, 500), updatedAt: Date.now() });
    }
    return null;
  },
});

export const contexteOperation = internalQuery({
  args: { operationId: v.id("planning_salaries_google_operations") },
  returns: v.union(v.null(), v.object({
    calendarId: v.string(),
    eventId: v.string(),
    googleICalUid: v.optional(v.string()),
    googleOccurrenceStart: v.string(),
    sourceResourceCalendarId: v.string(),
    targetResourceCalendarId: v.string(),
    managedResourceCalendarIds: v.array(v.string()),
  })),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || operation.statut === "traitee" || operation.tentatives >= 3) return null;
    const creneau = await ctx.db.get(operation.creneauId);
    if (!creneau) return null;
    const salaries = await ctx.db.query("planning_salaries_annuaire").take(MAX_SALARIES + 1);
    if (salaries.length > MAX_SALARIES) return null;
    return {
      calendarId: creneau.googleCalendarId,
      eventId: creneau.googleEventId,
      ...(creneau.googleICalUid ? { googleICalUid: creneau.googleICalUid } : {}),
      googleOccurrenceStart: creneau.googleOccurrenceStart,
      sourceResourceCalendarId: operation.sourceResourceCalendarId,
      targetResourceCalendarId: operation.targetResourceCalendarId,
      managedResourceCalendarIds: [
        PLACEHOLDER_RESOURCE,
        ...salaries.map((salarie) => salarie.resourceCalendarId),
      ],
    };
  },
});

export const marquerOperation = internalMutation({
  args: {
    operationId: v.id("planning_salaries_google_operations"),
    succes: v.boolean(),
    erreur: v.optional(v.string()),
    etag: v.optional(v.string()),
  },
  returns: v.object({ retry: v.boolean(), tentatives: v.number() }),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || operation.statut === "traitee") return { retry: false, tentatives: operation?.tentatives ?? 0 };
    const tentatives = operation.tentatives + 1;
    if (args.succes) {
      await ctx.db.patch(operation._id, { statut: "traitee", tentatives, derniereErreur: undefined, prochaineTentativeAt: undefined, updatedAt: Date.now() });
      const creneau = await ctx.db.get(operation.creneauId);
      if (creneau) {
        await ctx.db.patch(creneau._id, {
          currentResourceCalendarId: operation.targetResourceCalendarId,
          ...(args.etag ? { etag: args.etag } : {}),
          updatedAt: Date.now(),
        });
      }
    } else {
      await ctx.db.patch(operation._id, { statut: "echec", tentatives, derniereErreur: (args.erreur ?? "Erreur Google").slice(0, 500), prochaineTentativeAt: undefined, updatedAt: Date.now() });
    }
    return { retry: !args.succes && tentatives < 3, tentatives };
  },
});

export const placeholder = PLACEHOLDER_RESOURCE;
