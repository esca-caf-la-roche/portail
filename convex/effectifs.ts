import { authenticatedQuery as query, authenticatedMutation as mutation } from "./customFunctions";
import { ConvexError, v } from "convex/values";
import { requireTile } from "./access";
import { champsModifies } from "./dbUtils";

const MAX_EFFECTIF = 10_000;

function normaliserEffectif(valeur: number, libelle: string): number {
  if (!Number.isFinite(valeur) || valeur < 0 || valeur > MAX_EFFECTIF) {
    throw new ConvexError(`${libelle} doit être compris entre 0 et ${MAX_EFFECTIF}.`);
  }
  return Math.round(valeur);
}

// Synthèse pour l'onglet « Coût par membre » du budget prévisionnel.
// Renvoie les effectifs et la part « base de données » des dépenses ventilées
// loisir / compétition. La masse salariale (calculée côté front à partir de la paie)
// est ajoutée par le composant aux dépenses ci-dessous pour obtenir le total.
export const getSynthese = query({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    // Membres loisir : saisi à la main (persisté par saison), 0 par défaut.
    const eff = await ctx.db
      .query("budgetEffectifs")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .first();
    const nbMembresLoisir = eff?.nbMembresLoisir ?? 0;

    // Membres compétition : Σ des élèves max des TYPES de cours compétition (un type
    // distinct compté une fois, quel que soit le nombre de créneaux).
    const cours = await ctx.db
      .query("cours")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .collect();
    const elevesMaxParTypeCompet = new Map<string, number>();
    for (const c of cours) {
      if (c.competition) elevesMaxParTypeCompet.set(c.nom, c.nbElevesMax);
    }
    let nbMembresCompetition = 0;
    for (const n of elevesMaxParTypeCompet.values()) nbMembresCompetition += n;

    // Dépenses prévisionnelles en base, ventilées loisir / compétition (montant < 0).
    // Les inscriptions (recettes, montant ≥ 0) ne comptent pas comme dépenses.
    const prevs = await ctx.db
      .query("previsionnels")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .collect();
    let depPrevLoisir = 0;
    let depPrevCompetition = 0;
    for (const p of prevs) {
      if (p.montant >= 0) continue;
      if (p.competition) depPrevCompetition += -p.montant;
      else depPrevLoisir += -p.montant;
    }

    return {
      nbMembresLoisir,
      nbMembresCompetition,
      depPrevLoisir,
      depPrevCompetition,
    };
  },
});

// Enregistre (upsert) le nombre de membres loisir pour une saison.
export const setMembresLoisir = mutation({
  args: { saison: v.string(), nbMembresLoisir: v.number() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    const nb = normaliserEffectif(args.nbMembresLoisir, "Le nombre de membres loisir");
    const existing = await ctx.db
      .query("budgetEffectifs")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .first();
    if (existing) {
      const patch = { nbMembresLoisir: nb };
      if (champsModifies(existing, patch)) await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("budgetEffectifs", { saison: args.saison, nbMembresLoisir: nb });
    }
  },
});
