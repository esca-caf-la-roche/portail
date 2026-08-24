import { authenticatedQuery as query, authenticatedMutation as mutation } from "./customFunctions";
import { v, ConvexError } from "convex/values";
import { nextSaison } from "./saisonUtils";
import type { MutationCtx } from "./_generated/server";
import { requireAdmin } from "./access";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const saisons = await ctx.db.query("saisons").collect();
    return saisons.sort((a, b) => b.nom.localeCompare(a.nom)); // Tri décroissant: plus récent en premier
  },
});

export const create = mutation({
  args: { nom: v.string(), isDefault: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);
    const isDefault = args.isDefault ?? false;
    
    if (isDefault) {
      // Retirer le default des autres
      const all = await ctx.db.query("saisons").collect();
      for (const s of all) {
        if (s.isDefault) {
          await ctx.db.patch(s._id, { isDefault: false });
        }
      }
    }
    
    return await ctx.db.insert("saisons", { nom: args.nom, isDefault });
  },
});

// Ajoute la saison suivante (séquentielle) et reprend les données de la
// saison la plus récente : paramètres de paie + lignes de salaire (les
// montants sont copiés tels quels, l'admin ajuste ensuite l'augmentation).
export const createNext = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx, ctx.userId);

    const all = await ctx.db.query("saisons").collect();
    if (all.length === 0) {
      throw new ConvexError("Aucune saison existante : créez une première saison manuellement.");
    }
    // La plus récente au format "YYYY-YY".
    const latest = all
      .map((s) => s.nom)
      .filter((n) => /^\d{4}-\d{2}$/.test(n))
      .sort((a, b) => b.localeCompare(a))[0];
    if (!latest) {
      throw new ConvexError("Format de saison non reconnu (attendu : AAAA-AA).");
    }
    const suivante = nextSaison(latest);
    if (!suivante) {
      throw new ConvexError("Impossible de calculer la saison suivante.");
    }
    if (all.some((s) => s.nom === suivante)) {
      throw new ConvexError(`La saison ${suivante} existe déjà.`);
    }

    const newId = await ctx.db.insert("saisons", { nom: suivante, isDefault: false });

    // Reprise des paramètres de paie de la saison précédente.
    const prevParams = await ctx.db
      .query("parametresPaie")
      .withIndex("by_saison", (q) => q.eq("saison", latest))
      .first();
    if (prevParams) {
      await ctx.db.insert("parametresPaie", {
        saison: suivante,
        margeSecurite: prevParams.margeSecurite,
        indemniteCpPct: prevParams.indemniteCpPct,
        mutuelleSalarie: prevParams.mutuelleSalarie,
        mutuelleEmployeur: prevParams.mutuelleEmployeur,
        primeEquipementAnnuelle: prevParams.primeEquipementAnnuelle,
        fraisBulletin: prevParams.fraisBulletin,
        cotisationsSalariales: prevParams.cotisationsSalariales,
        cotisationsPatronales: prevParams.cotisationsPatronales,
      });
    }

    // Reprise des lignes de salaire (mêmes moniteurs, mêmes montants).
    const prevLignes = await ctx.db
      .query("salairesSaison")
      .withIndex("by_saison", (q) => q.eq("saison", latest))
      .collect();
    for (const l of prevLignes) {
      await ctx.db.insert("salairesSaison", {
        salarieId: l.salarieId,
        saison: suivante,
        nbHeuresAnnuel: l.nbHeuresAnnuel,
        nbMois: l.nbMois,
        tauxHoraireBrut: l.tauxHoraireBrut,
        augmentationPct: 0,
        actif: l.actif ?? true,
      });
    }

    return { id: newId, nom: suivante, lignesReprises: prevLignes.length };
  },
});

export const update = mutation({
  args: { id: v.id("saisons"), isDefault: v.boolean() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);
    if (args.isDefault) {
      const all = await ctx.db.query("saisons").collect();
      for (const s of all) {
        if (s.isDefault && s._id !== args.id) {
          await ctx.db.patch(s._id, { isDefault: false });
        }
      }
    }
    await ctx.db.patch(args.id, { isDefault: args.isDefault });
  },
});

export const remove = mutation({
  args: { id: v.id("saisons") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);
    // NB : on lève des `ConvexError` (et non `Error`) car en production Convex
    // masque le message des `Error` classiques ("Server Error"). La charge utile
    // d'une `ConvexError` est, elle, transmise au client (error.data).
    const saison = await ctx.db.get(args.id);
    if (!saison) throw new ConvexError("Saison introuvable.");

    if (saison.isDefault) {
      throw new ConvexError(
        "Impossible de supprimer la saison par défaut. Définissez une autre saison par défaut d'abord.",
      );
    }

    // Donnée comptable « réelle » saisie à la main : on refuse la suppression et
    // on indique précisément ce qui bloque.
    const txs = await ctx.db
      .query("transactions")
      .withIndex("by_saison", (q) => q.eq("saison", saison.nom))
      .collect();
    const prevsManuels = (
      await ctx.db
        .query("previsionnels")
        .withIndex("by_saison", (q) => q.eq("saison", saison.nom))
        .collect()
    ).filter((p) => !p.auto); // les lignes `auto` sont régénérées depuis les cours
    if (txs.length > 0 || prevsManuels.length > 0) {
      const parts: string[] = [];
      if (txs.length > 0) parts.push(`${txs.length} transaction(s)`);
      if (prevsManuels.length > 0) parts.push(`${prevsManuels.length} ligne(s) de prévisionnel`);
      throw new ConvexError(
        `Cette saison contient ${parts.join(" et ")} : supprimez-les d'abord.`,
      );
    }

    // Les réservations des samedis sont des inscriptions réelles : leur
    // présence bloque la suppression de la saison afin d'éviter toute perte
    // silencieuse ou réservation orpheline.
    const reservationSamedi = await ctx.db
      .query("samedis_reservations")
      .withIndex("by_saison", (q) => q.eq("saison", saison.nom))
      .first();
    if (reservationSamedi) {
      throw new ConvexError(
        "Cette saison contient des réservations de samedis : annulez-les d'abord.",
      );
    }

    // Données dérivées, générées automatiquement (createNext / planning des cours) :
    // on les nettoie en cascade pour ne pas laisser d'orphelins.
    await deleteBySaison(ctx, "previsionnels", saison.nom); // lignes auto restantes
    await deleteBySaison(ctx, "parametresPaie", saison.nom);
    await deleteBySaison(ctx, "salairesSaison", saison.nom);
    await deleteBySaison(ctx, "cours", saison.nom);
    await deleteBySaison(ctx, "budgetEffectifs", saison.nom);
    // IO-BOUNDED: une configuration et au plus 53 créneaux hebdomadaires par saison.
    await deleteBySaison(ctx, "samedis_configurations", saison.nom);
    await deleteBySaison(ctx, "samedis_creneaux", saison.nom);

    await ctx.db.delete(args.id);
  },
});

// Supprime toutes les lignes d'une table saisonnière (index `by_saison`) pour un
// nom de saison donné. Réservé aux tables indexées par `saison`.
type SaisonTable =
  | "previsionnels"
  | "parametresPaie"
  | "salairesSaison"
  | "cours"
  | "budgetEffectifs"
  | "samedis_configurations"
  | "samedis_creneaux";

async function deleteBySaison(ctx: MutationCtx, table: SaisonTable, saison: string) {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}
