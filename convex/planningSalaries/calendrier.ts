import { ConvexError, v } from "convex/values";
import { authenticatedQuery } from "../customFunctions";
import {
  getIdentite,
  MAX_CRENEAUX_PAR_SAISON,
  MAX_SALARIES,
  PLACEHOLDER_RESOURCE,
  requireGestionnaire,
  verifierSaison,
} from "./lib";

const compteurValidator = v.object({
  salarieId: v.union(v.null(), v.id("planning_salaries_annuaire")),
  prenom: v.string(),
  samedis: v.number(),
});

export const list = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.object({
    gestionnaire: v.boolean(),
    creneaux: v.array(v.object({
      _id: v.id("planning_salaries_creneaux"),
      date: v.string(),
      debut: v.string(),
      fin: v.string(),
      groupe: v.string(),
      titre: v.string(),
      salarie: v.union(v.null(), v.object({
        _id: v.id("planning_salaries_annuaire"),
        prenom: v.string(),
      })),
      googleAJour: v.boolean(),
    })),
    compteurs: v.array(compteurValidator),
  }),
  handler: async (ctx, args) => {
    const { gestionnaire } = await getIdentite(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    const [creneaux, affectations, salaries] = await Promise.all([
      ctx.db.query("planning_salaries_creneaux")
        .withIndex("by_saison", (q) => q.eq("saison", saison)).take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.query("planning_salaries_affectations")
        .withIndex("by_saison", (q) => q.eq("saison", saison)).take(MAX_CRENEAUX_PAR_SAISON + 1),
      ctx.db.query("planning_salaries_annuaire").take(MAX_SALARIES + 1),
    ]);
    if (creneaux.length > MAX_CRENEAUX_PAR_SAISON || affectations.length > MAX_CRENEAUX_PAR_SAISON) {
      throw new ConvexError("Volume du planning supérieur à la limite prévue.");
    }
    const salariesParId = new Map(salaries.map((s) => [s._id, s]));
    const creneauParId = new Map(creneaux.map((creneau) => [creneau._id, creneau]));
    const candidatesParDate = new Map<string, typeof affectations>();
    for (const affectation of affectations) {
      const date = affectation.date ?? (
        affectation.creneauId
          ? creneauParId.get(affectation.creneauId)?.date
          : undefined
      );
      if (!date) continue;
      candidatesParDate.set(date, [
        ...(candidatesParDate.get(date) ?? []),
        affectation,
      ]);
    }
    const affectationParDate = new Map<string, (typeof affectations)[number]>();
    for (const [date, candidates] of candidatesParDate) {
      if (new Set(candidates.map((item) => item.salarieId)).size > 1) {
        throw new ConvexError(
          `Plusieurs salariés historiques sont affectés au samedi ${date}. ` +
          "La migration doit être arbitrée par un gestionnaire.",
        );
      }
      if (candidates[0]) affectationParDate.set(date, candidates[0]);
    }
    const samedisParSalarie = new Map<string, number>();
    for (const date of new Set(creneaux.map((creneau) => creneau.date))) {
      const affectation = affectationParDate.get(date);
      const cle = affectation?.salarieId ?? "placeholder";
      samedisParSalarie.set(cle, (samedisParSalarie.get(cle) ?? 0) + 1);
    }
    const compteurs = [
      {
        salarieId: null,
        prenom: "À déterminer",
        samedis: samedisParSalarie.get("placeholder") ?? 0,
      },
      ...salaries.map((salarie) => ({
        salarieId: salarie._id,
        prenom: salarie.prenom,
        samedis: samedisParSalarie.get(salarie._id) ?? 0,
      })),
    ];
    return {
      gestionnaire,
      creneaux: creneaux.map((creneau) => {
        const affectation = affectationParDate.get(creneau.date);
        const salarie = affectation ? salariesParId.get(affectation.salarieId) : null;
        return {
          _id: creneau._id,
          date: creneau.date,
          debut: creneau.debut,
          fin: creneau.fin,
          groupe: creneau.groupe,
          titre: creneau.titre,
          salarie: salarie ? { _id: salarie._id, prenom: salarie.prenom } : null,
          googleAJour: creneau.currentResourceCalendarId === (salarie?.resourceCalendarId ?? PLACEHOLDER_RESOURCE),
        };
      }),
      compteurs,
    };
  },
});

export const etatGestionnaire = authenticatedQuery({
  args: { saison: v.string() },
  returns: v.object({
    sync: v.union(v.null(), v.object({
      statut: v.string(),
      derniereSynchronisationAt: v.union(v.null(), v.number()),
      derniereErreur: v.union(v.null(), v.string()),
    })),
    operationsEnErreur: v.number(),
    alertesEnErreur: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const saison = verifierSaison(args.saison);
    const [sync, operations, alertes] = await Promise.all([
      ctx.db.query("planning_salaries_sync").withIndex("by_saison_and_cle", (q) => q.eq("saison", saison).eq("cle", "google_calendar")).unique(),
      ctx.db.query("planning_salaries_google_operations").withIndex("by_saison_and_statut", (q) => q.eq("saison", saison).eq("statut", "echec")).take(101),
      ctx.db.query("planning_salaries_alertes").withIndex("by_saison", (q) => q.eq("saison", saison)).take(101),
    ]);
    return {
      sync: sync ? {
        statut: sync.statut,
        derniereSynchronisationAt: sync.derniereSynchronisationAt ?? null,
        derniereErreur: sync.derniereErreur ?? null,
      } : null,
      operationsEnErreur: operations.length,
      alertesEnErreur: alertes.filter((a) => a.statut === "echec").length,
    };
  },
});
