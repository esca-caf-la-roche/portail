// État opérationnel compact des imports, transversal aux tuiles qui les utilisent.
// SAISON-EXEMPT: ces imports décrivent les sources courantes, pas une saison comptable.
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { authenticatedQuery } from "../customFunctions";
import { getUserSettings } from "../access";
import { champsModifies } from "../dbUtils";

const sources = ["helloasso", "helloasso_abo", "helloasso_cours", "scrap", "annuaire", "eleves"] as const;
const sourceValidator = v.union(v.literal("helloasso"), v.literal("helloasso_abo"), v.literal("helloasso_cours"), v.literal("scrap"), v.literal("annuaire"), v.literal("eleves"));
const etatValidator = v.union(v.literal("en_cours"), v.literal("reussie"), v.literal("echec"));

export const marquer = internalMutation({
  args: { source: sourceValidator, tentativeAt: v.string(), etat: etatValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cle = `etat_sync_${args.source}`;
    const row = await ctx.db.query("abo_app_config").withIndex("by_cle", (q) => q.eq("cle", cle)).unique();
    let precedent: { tentativeAt: string; etat: string } | null = null;
    try {
      const parsed: unknown = row?.valeur ? JSON.parse(row.valeur) : null;
      if (parsed && typeof parsed === "object" && "tentativeAt" in parsed && "etat" in parsed &&
        typeof parsed.tentativeAt === "string" && typeof parsed.etat === "string") {
        precedent = { tentativeAt: parsed.tentativeAt, etat: parsed.etat };
      }
    } catch { /* ancien format */ }
    // Une tentative ancienne ne peut ni effacer une réussite ni masquer un échec récent.
    if (precedent && precedent.tentativeAt > args.tentativeAt) return null;
    if (precedent?.tentativeAt === args.tentativeAt && precedent.etat !== "en_cours" && args.etat === "en_cours") return null;
    if (precedent?.tentativeAt === args.tentativeAt && precedent.etat === args.etat) return null;
    const patch = {
      valeur: JSON.stringify({ tentativeAt: args.tentativeAt, etat: args.etat }),
      updated_at: args.tentativeAt,
    };
    if (row) {
      if (champsModifies(row, patch)) await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("abo_app_config", { cle, ...patch });
    }
    return null;
  },
});

export const resume = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    source: sourceValidator,
    etat: etatValidator,
    tentativeAt: v.string(),
    lien: v.string(),
  })),
  handler: async (ctx) => {
    const settings = await getUserSettings(ctx, ctx.userId);
    if (!settings) return [];
    const tiles = settings.allowedTiles;
    const visibles = sources.filter((source) =>
      (tiles.includes("abonnements") && source !== "helloasso_cours") ||
      (source === "helloasso" && tiles.includes("paiements")) ||
      (source === "helloasso_abo" && tiles.includes("abonnements")) ||
      (source === "helloasso_cours" && tiles.includes("paiements")) ||
      ((source === "annuaire" || source === "eleves") && tiles.includes("licences_cours")) ||
      (source === "eleves" && tiles.includes("contacts_cours"))
    );
    const rows = await Promise.all(visibles.map((source) => ctx.db.query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", `etat_sync_${source}`)).unique()));
    return visibles.flatMap((source, i) => {
      const raw = rows[i]?.valeur;
      if (!raw) return [];
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || !("etat" in value) || !("tentativeAt" in value)) return [];
        if (value.etat !== "en_cours" && value.etat !== "reussie" && value.etat !== "echec") return [];
        if (typeof value.tentativeAt !== "string") return [];
        const lien = source === "helloasso_abo" ? "/gestion-abonnements" :
          source === "helloasso_cours" ? "/paiements/validation" :
          tiles.includes("abonnements") ? "/gestion-abonnements" :
          source === "helloasso" ? "/paiements/validation" :
          tiles.includes("licences_cours") ? "/licences-cours" : "/contacts-cours";
        return [{ source, etat: value.etat as "en_cours" | "reussie" | "echec", tentativeAt: value.tentativeAt, lien }];
      } catch { return []; }
    });
  },
});
