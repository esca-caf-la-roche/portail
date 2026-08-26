import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { champsModifies } from "../dbUtils";
import {
  bornesSaison,
  getIdentite,
  MAX_CRENEAUX_PAR_SAISON,
  PLACEHOLDER_RESOURCE,
  requireGestionnaire,
} from "./lib";

async function creerOperation(
  ctx: MutationCtx,
  args: {
    saison: string;
    date: string;
    creneauId: Id<"planning_salaries_creneaux">;
    affectationId?: Id<"planning_salaries_affectations">;
    source: string;
    cible: string;
  },
) {
  if (args.source.toLowerCase() === args.cible.toLowerCase()) return null;
  const operations = await ctx.db.query("planning_salaries_google_operations")
    .withIndex("by_creneauId", (q) => q.eq("creneauId", args.creneauId))
    .take(21);
  if (operations.length > 20) {
    throw new ConvexError("Trop d'opérations Google existent pour cet événement.");
  }
  if (operations.some((o) =>
    o.creneauId === args.creneauId &&
    (o.statut === "a_traiter" || o.statut === "en_cours")
  )) {
    throw new ConvexError("Une mise à jour Google est déjà en cours pour ce samedi.");
  }
  // Une intention plus récente supplante un échec définitif. Une éventuelle
  // tâche de retry déjà planifiée relira un identifiant absent et fera no-op.
  for (const operation of operations) {
    if (operation.creneauId === args.creneauId && operation.statut === "echec") {
      await ctx.db.delete(operation._id);
    }
  }
  const idempotencyKey = `${args.creneauId}:${args.source.toLowerCase()}>${args.cible.toLowerCase()}:${Date.now()}`;
  const now = Date.now();
  const operationId = await ctx.db.insert("planning_salaries_google_operations", {
    saison: args.saison,
    date: args.date,
    creneauId: args.creneauId,
    affectationId: args.affectationId,
    type: "remplacer_ressource",
    idempotencyKey,
    sourceResourceCalendarId: args.source,
    targetResourceCalendarId: args.cible,
    statut: "a_traiter",
    tentatives: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.planningSalaries.google.traiterOperation, { operationId });
  return operationId;
}

async function contientAffectationLegacy(
  ctx: MutationCtx,
  creneaux: Array<{ _id: Id<"planning_salaries_creneaux"> }>,
): Promise<boolean> {
  for (const creneau of creneaux) {
    const legacy = await ctx.db.query("planning_salaries_affectations")
      .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
      .first();
    if (legacy) return true;
  }
  return false;
}

export const affecter = authenticatedMutation({
  args: {
    saison: v.string(),
    date: v.string(),
    salarieId: v.optional(v.id("planning_salaries_annuaire")),
  },
  returns: v.id("planning_salaries_affectations"),
  handler: async (ctx, args) => {
    const identite = await getIdentite(ctx, ctx.userId);
    const salarieId = identite.gestionnaire ? args.salarieId : identite.salarie?._id;
    if (!salarieId) throw new ConvexError("Sélectionnez un salarié.");
    const bornes = bornesSaison(args.saison);
    if (args.date < bornes.dateDebut || args.date > bornes.dateFin) {
      throw new ConvexError("Ce samedi n'appartient pas à la saison sélectionnée.");
    }
    const [creneaux, salarie, existante] = await Promise.all([
      ctx.db.query("planning_salaries_creneaux")
        .withIndex("by_saison_and_date", (q) =>
          q.eq("saison", bornes.saison).eq("date", args.date))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.get(salarieId),
      ctx.db.query("planning_salaries_affectations")
        .withIndex("by_saison_and_date", (q) =>
          q.eq("saison", bornes.saison).eq("date", args.date))
        .unique(),
    ]);
    if (creneaux.length === 0) throw new ConvexError("Samedi introuvable.");
    if (creneaux.length > MAX_CRENEAUX_PAR_SAISON) {
      throw new ConvexError("Trop d'événements sont rattachés à ce samedi.");
    }
    if (!existante && await contientAffectationLegacy(ctx, creneaux)) {
      throw new ConvexError(
        "Les anciennes affectations doivent être migrées avant de modifier ce samedi.",
      );
    }
    if (!salarie?.actif) throw new ConvexError("Salarié actif introuvable.");
    if (
      existante &&
      !identite.gestionnaire &&
      existante.salarieId !== identite.salarie?._id
    ) {
      throw new ConvexError("Ce samedi est déjà attribué à un autre salarié.");
    }
    const now = Date.now();
    let affectationId: Id<"planning_salaries_affectations">;
    if (existante) {
      const patch = {
        salarieId: salarie._id,
        resourceCalendarIdSnapshot: salarie.resourceCalendarId,
        updatedBy: ctx.userId,
        updatedAt: now,
      };
      if (champsModifies(existante, patch, ["updatedAt"])) await ctx.db.patch(existante._id, patch);
      affectationId = existante._id;
    } else {
      affectationId = await ctx.db.insert("planning_salaries_affectations", {
        saison: bornes.saison,
        date: args.date,
        salarieId: salarie._id,
        resourceCalendarIdSnapshot: salarie.resourceCalendarId,
        createdBy: ctx.userId,
        createdAt: now,
        updatedBy: ctx.userId,
        updatedAt: now,
      });
    }
    for (const creneau of creneaux) {
      await creerOperation(ctx, {
        saison: creneau.saison,
        date: creneau.date,
        creneauId: creneau._id,
        affectationId,
        source: creneau.currentResourceCalendarId,
        cible: salarie.resourceCalendarId,
      });
    }
    await ctx.scheduler.runAfter(0, internal.planningSalaries.alertes.reconcilierDate, {
      saison: bornes.saison,
      date: args.date,
      maintenant: now,
    });
    return affectationId;
  },
});

export const retirer = authenticatedMutation({
  args: { saison: v.string(), date: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identite = await getIdentite(ctx, ctx.userId);
    const { saison } = bornesSaison(args.saison);
    const [creneaux, affectation] = await Promise.all([
      ctx.db.query("planning_salaries_creneaux")
        .withIndex("by_saison_and_date", (q) =>
          q.eq("saison", saison).eq("date", args.date))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.query("planning_salaries_affectations")
        .withIndex("by_saison_and_date", (q) =>
          q.eq("saison", saison).eq("date", args.date))
        .unique(),
    ]);
    if (!affectation) {
      if (await contientAffectationLegacy(ctx, creneaux)) {
        throw new ConvexError(
          "Les anciennes affectations doivent être migrées avant de modifier ce samedi.",
        );
      }
      return null;
    }
    if (!identite.gestionnaire && affectation.salarieId !== identite.salarie?._id) {
      throw new ConvexError("Vous ne pouvez retirer que votre propre inscription.");
    }
    for (const creneau of creneaux) {
      await creerOperation(ctx, {
        saison: creneau.saison,
        date: creneau.date,
        creneauId: creneau._id,
        source: creneau.currentResourceCalendarId,
        cible: PLACEHOLDER_RESOURCE,
      });
    }
    await ctx.db.delete(affectation._id);
    await ctx.scheduler.runAfter(0, internal.planningSalaries.alertes.reconcilierDate, {
      saison,
      date: args.date,
      maintenant: Date.now(),
    });
    return null;
  },
});

export const listEchecs = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.array(v.object({
    _id: v.id("planning_salaries_google_operations"),
    creneauId: v.id("planning_salaries_creneaux"),
    date: v.string(),
    tentatives: v.number(),
    derniereErreur: v.union(v.null(), v.string()),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const operations = await ctx.db.query("planning_salaries_google_operations")
      .withIndex("by_saison_and_statut", (q) => q.eq("saison", args.saison).eq("statut", "echec")).take(50);
    const resultat = [];
    for (const operation of operations) {
      const creneau = operation.date ? null : await ctx.db.get(operation.creneauId);
      resultat.push({
        _id: operation._id,
        creneauId: operation.creneauId,
        date: operation.date ?? creneau?.date ?? "Date inconnue",
        tentatives: operation.tentatives,
        derniereErreur: operation.derniereErreur ?? null,
        updatedAt: operation.updatedAt,
      });
    }
    return resultat;
  },
});

export const relancer = authenticatedMutation({
  args: { operationId: v.id("planning_salaries_google_operations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new ConvexError("Opération introuvable.");
    if (operation.statut === "traitee") return null;
    await ctx.db.patch(operation._id, { statut: "a_traiter", tentatives: 0, derniereErreur: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.planningSalaries.google.traiterOperation, args);
    return null;
  },
});
