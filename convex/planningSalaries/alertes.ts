import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { parisWallToUtcMs } from "../abo/config";
import { MAX_CRENEAUX_PAR_SAISON, MAX_SALARIES, requireGestionnaire } from "./lib";

function echeanceAlerte(date: string): number {
  const samedi = new Date(`${date}T12:00:00Z`);
  samedi.setUTCDate(samedi.getUTCDate() - 7);
  const dateJ7 = samedi.toISOString().slice(0, 10);
  const valeur = parisWallToUtcMs(`${dateJ7}T09:00`);
  if (valeur === null) throw new Error("Date d'alerte invalide.");
  return valeur;
}

async function aUneAffectation(
  ctx: MutationCtx | QueryCtx,
  saison: string,
  date: string,
  creneaux: Doc<"planning_salaries_creneaux">[],
): Promise<boolean> {
  const affectation = await ctx.db.query("planning_salaries_affectations")
    .withIndex("by_saison_and_date", (q) =>
      q.eq("saison", saison).eq("date", date))
    .unique();
  if (affectation) return true;
  // Compatibilité WIDEN : évite une fausse alerte entre le déploiement du
  // schéma et l'exécution de la migration des affectations historiques.
  for (const creneau of creneaux) {
    const legacy = await ctx.db.query("planning_salaries_affectations")
      .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
      .first();
    if (legacy) return true;
  }
  return false;
}

export const reconcilierDate = internalMutation({
  args: { saison: v.string(), date: v.string(), maintenant: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const creneaux = await ctx.db.query("planning_salaries_creneaux")
      .withIndex("by_saison_and_date", (q) => q.eq("saison", args.saison).eq("date", args.date))
      .take(MAX_CRENEAUX_PAR_SAISON + 1);
    const aDeterminer = !(await aUneAffectation(
      ctx,
      args.saison,
      args.date,
      creneaux,
    ));
    const alerte = await ctx.db.query("planning_salaries_alertes")
      .withIndex("by_saison_and_date", (q) => q.eq("saison", args.saison).eq("date", args.date)).unique();
    const finSamedi = parisWallToUtcMs(`${args.date}T23:59`);
    if (finSamedi !== null && args.maintenant > finSamedi) {
      if (alerte?.scheduledFunctionId) {
        await ctx.scheduler.cancel(alerte.scheduledFunctionId);
      }
      if (alerte && alerte.statut !== "envoyee" && alerte.statut !== "obsolete") {
        await ctx.db.patch(alerte._id, {
          statut: "obsolete",
          scheduledFunctionId: undefined,
          updatedAt: args.maintenant,
        });
      }
      return null;
    }
    if (!aDeterminer || creneaux.length === 0) {
      if (alerte?.scheduledFunctionId) await ctx.scheduler.cancel(alerte.scheduledFunctionId);
      if (alerte && alerte.statut === "planifiee") {
        await ctx.db.patch(alerte._id, { statut: "annulee", scheduledFunctionId: undefined, updatedAt: Date.now() });
      }
      return null;
    }
    if (
      alerte?.statut === "envoyee" ||
      alerte?.statut === "planifiee" ||
      alerte?.statut === "en_cours" ||
      alerte?.statut === "echec"
    ) return null;
    const echeanceAt = echeanceAlerte(args.date);
    const lancement = Math.max(args.maintenant, echeanceAt);
    const alerteId = alerte?._id ?? await ctx.db.insert("planning_salaries_alertes", {
      saison: args.saison,
      date: args.date,
      echeanceAt,
      statut: "planifiee",
      tentatives: 0,
      createdAt: args.maintenant,
      updatedAt: args.maintenant,
    });
    const scheduledFunctionId = await ctx.scheduler.runAt(lancement, internal.planningSalaries.alertes.envoyer, { alerteId });
    await ctx.db.patch(alerteId, { statut: "planifiee", scheduledFunctionId, echeanceAt, derniereErreur: undefined, updatedAt: args.maintenant });
    return null;
  },
});

export const reconcilierSaison = internalMutation({
  args: { saison: v.string(), maintenant: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [creneaux, alertes] = await Promise.all([
      ctx.db.query("planning_salaries_creneaux")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.query("planning_salaries_alertes")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .take(MAX_CRENEAUX_PAR_SAISON + 1),
    ]);
    const dates = [...new Set([
      ...creneaux.map((c) => c.date),
      ...alertes.map((alerte) => alerte.date),
    ])];
    for (const date of dates) {
      await ctx.scheduler.runAfter(0, internal.planningSalaries.alertes.reconcilierDate, { ...args, date });
    }
    return null;
  },
});

export const contexte = internalQuery({
  args: { alerteId: v.id("planning_salaries_alertes") },
  returns: v.union(v.null(), v.object({ date: v.string(), groupes: v.array(v.string()), bcc: v.array(v.string()) })),
  handler: async (ctx, args) => {
    const alerte = await ctx.db.get(args.alerteId);
    if (!alerte || alerte.statut === "envoyee" || alerte.statut === "annulee") return null;
    const creneaux = await ctx.db.query("planning_salaries_creneaux")
      .withIndex("by_saison_and_date", (q) => q.eq("saison", alerte.saison).eq("date", alerte.date)).take(MAX_CRENEAUX_PAR_SAISON + 1);
    if (
      creneaux.length === 0 ||
      await aUneAffectation(ctx, alerte.saison, alerte.date, creneaux)
    ) return null;
    const groupes = creneaux.map((creneau) => creneau.groupe);
    const salaries = await ctx.db.query("planning_salaries_annuaire")
      .withIndex("by_actif", (q) => q.eq("actif", true)).take(MAX_SALARIES + 1);
    return { date: alerte.date, groupes, bcc: salaries.map((s) => s.email) };
  },
});

export const marquerResultat = internalMutation({
  args: { alerteId: v.id("planning_salaries_alertes"), succes: v.boolean(), erreur: v.optional(v.string()) },
  returns: v.object({ retry: v.boolean(), tentatives: v.number() }),
  handler: async (ctx, args) => {
    const alerte = await ctx.db.get(args.alerteId);
    if (!alerte || alerte.statut === "envoyee") return { retry: false, tentatives: alerte?.tentatives ?? 0 };
    const tentatives = alerte.tentatives + 1;
    await ctx.db.patch(alerte._id, args.succes
      ? { statut: "envoyee", tentatives, envoyeeAt: Date.now(), scheduledFunctionId: undefined, derniereErreur: undefined, updatedAt: Date.now() }
      : { statut: "echec", tentatives, scheduledFunctionId: undefined, derniereErreur: (args.erreur ?? "Erreur SMTP").slice(0, 500), updatedAt: Date.now() });
    return { retry: !args.succes && tentatives < 3, tentatives };
  },
});

export const preparerEnvoi = internalMutation({
  args: { alerteId: v.id("planning_salaries_alertes") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const alerte = await ctx.db.get(args.alerteId);
    if (!alerte || (alerte.statut !== "planifiee" && alerte.statut !== "echec")) {
      return false;
    }
    await ctx.db.patch(alerte._id, {
      statut: "en_cours",
      scheduledFunctionId: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const marquerObsolete = internalMutation({
  args: { alerteId: v.id("planning_salaries_alertes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const alerte = await ctx.db.get(args.alerteId);
    if (alerte && alerte.statut !== "envoyee") {
      await ctx.db.patch(alerte._id, {
        statut: "obsolete",
        scheduledFunctionId: undefined,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const envoyer = internalAction({
  args: { alerteId: v.id("planning_salaries_alertes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doitEnvoyer: boolean = await ctx.runMutation(
      internal.planningSalaries.alertes.preparerEnvoi,
      args,
    );
    if (!doitEnvoyer) return null;
    const donnees: { date: string; groupes: string[]; bcc: string[] } | null =
      await ctx.runQuery(internal.planningSalaries.alertes.contexte, args);
    if (!donnees) {
      await ctx.runMutation(internal.planningSalaries.alertes.marquerObsolete, args);
      return null;
    }
    try {
      await ctx.runAction(internal.email.sendPlanningSalariesEmail, {
        to: "escalade@caflarochebonneville.fr",
        bcc: donnees.bcc,
        subject: `URGENT — samedi ${donnees.date} sans moniteur`,
        text: `Le samedi ${donnees.date} approche et aucun salarié ne le prend encore en charge.\n\nGroupes concernés :\n${donnees.groupes.map((g) => `- ${g}`).join("\n")}\n\nMerci à un salarié de prendre en charge ce samedi.`,
      });
      await ctx.runMutation(internal.planningSalaries.alertes.marquerResultat, { ...args, succes: true });
    } catch (cause) {
      const resultat: { retry: boolean; tentatives: number } = await ctx.runMutation(internal.planningSalaries.alertes.marquerResultat, {
        ...args, succes: false, erreur: cause instanceof Error ? cause.message : "Erreur SMTP",
      });
      if (resultat.retry) await ctx.scheduler.runAfter(60_000 * 2 ** (resultat.tentatives - 1), internal.planningSalaries.alertes.envoyer, args);
    }
    return null;
  },
});

export const listEchecs = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.array(v.object({ _id: v.id("planning_salaries_alertes"), date: v.string(), tentatives: v.number(), derniereErreur: v.union(v.null(), v.string()) })),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    return (await ctx.db.query("planning_salaries_alertes").withIndex("by_saison", (q) => q.eq("saison", args.saison)).take(100))
      .filter((a) => a.statut === "echec")
      .map((a) => ({ _id: a._id, date: a.date, tentatives: a.tentatives, derniereErreur: a.derniereErreur ?? null }));
  },
});

export const relancer = authenticatedMutation({
  args: { alerteId: v.id("planning_salaries_alertes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const alerte = await ctx.db.get(args.alerteId);
    if (!alerte || alerte.statut === "envoyee") return null;
    await ctx.db.patch(alerte._id, { statut: "planifiee", tentatives: 0, derniereErreur: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.planningSalaries.alertes.envoyer, args);
    return null;
  },
});
