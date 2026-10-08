import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "./customFunctions";
import { requireTile } from "./access";
import { champsModifies } from "./dbUtils";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ambassadeurFields, ambassadeurValidator, cleIdentite, importRowValidator, MAX_IMPORT, nettoyerChamps, planValidator, verifierRevision, type ImportRow } from "./competitionModel";

async function verifierSaison(ctx: QueryCtx | MutationCtx, saison: string) {
  const start = Number(saison.slice(0, 4));
  if (!/^\d{4}-\d{2}$/.test(saison) || Number(saison.slice(5)) !== (start + 1) % 100) throw new ConvexError("Saison invalide.");
  if (!await ctx.db.query("saisons").withIndex("by_nom", (q) => q.eq("nom", saison)).first()) throw new ConvexError("Saison introuvable.");
}

async function trouver(ctx: QueryCtx | MutationCtx, saison: string, key: string) {
  return ctx.db.query("competition_ambassadeurs").withIndex("by_saison_and_cleIdentite", (q) => q.eq("saison", saison).eq("cleIdentite", key)).unique();
}

async function fiche(ctx: QueryCtx | MutationCtx, saison: string, id: Id<"competition_ambassadeurs">, revision: number) {
  verifierRevision(revision);
  const doc = await ctx.db.get(id);
  if (!doc || doc.saison !== saison) throw new ConvexError("Fiche introuvable dans cette saison.");
  if (doc.revision !== revision) throw new ConvexError("Conflit : la fiche a changé. Rechargez et recommencez.");
  return doc;
}

export const list = authenticatedQuery({
  args: { saison: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(ambassadeurValidator),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    const p = args.paginationOpts;
    if (!Number.isInteger(p.numItems) || p.numItems < 1 || p.numItems > 50 || !Number.isInteger(p.maximumRowsRead) || p.maximumRowsRead! < 1 || p.maximumRowsRead! > 100) throw new ConvexError("Pagination limitée à 50 résultats et 100 lectures.");
    return ctx.db.query("competition_ambassadeurs").withIndex("by_saison", (q) => q.eq("saison", args.saison)).paginate(p);
  },
});

export const create = authenticatedMutation({
  args: { saison: v.string(), fields: ambassadeurFields, partenariatSigne: v.boolean() },
  returns: v.id("competition_ambassadeurs"),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    const fields = nettoyerChamps(args.fields);
    const key = cleIdentite(fields);
    if (await trouver(ctx, args.saison, key)) throw new ConvexError("Une fiche de cette identité existe déjà dans cette saison.");
    return ctx.db.insert("competition_ambassadeurs", { ...fields, saison: args.saison, cleIdentite: key, partenariatSigne: args.partenariatSigne, revision: 1, updatedAt: Date.now(), updatedBy: ctx.userId });
  },
});

export const update = authenticatedMutation({
  args: { saison: v.string(), id: v.id("competition_ambassadeurs"), revision: v.number(), fields: ambassadeurFields, partenariatSigne: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    const existing = await fiche(ctx, args.saison, args.id, args.revision);
    const fields = nettoyerChamps(args.fields);
    const key = cleIdentite(fields);
    const duplicate = await trouver(ctx, args.saison, key);
    if (duplicate && duplicate._id !== args.id) throw new ConvexError("Une fiche de cette identité existe déjà dans cette saison.");
    const doc = { ...fields, cleIdentite: key, partenariatSigne: args.partenariatSigne };
    if (champsModifies(existing, doc)) await ctx.db.patch(args.id, { ...doc, revision: existing.revision + 1, updatedAt: Date.now(), updatedBy: ctx.userId });
    return null;
  },
});

export const remove = authenticatedMutation({
  args: { saison: v.string(), id: v.id("competition_ambassadeurs"), revision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    await fiche(ctx, args.saison, args.id, args.revision);
    await ctx.db.delete(args.id);
    return null;
  },
});

async function preparer(ctx: QueryCtx | MutationCtx, saison: string, rows: ImportRow[]): Promise<Infer<typeof planValidator>[]> {
  if (rows.length < 1 || rows.length > MAX_IMPORT || JSON.stringify(rows).length > 400_000) throw new ConvexError("Import limité à 200 lignes et 400 Ko de données.");
  const keys = new Set<string>();
  const ids = new Set<string>();
  const result: Infer<typeof planValidator>[] = [];
  for (const row of rows) {
    if (row.saison !== undefined && row.saison !== saison) throw new ConvexError("Le fichier contient une autre saison.");
    if ((row.id === undefined) !== (row.revision === undefined)) throw new ConvexError("Identifiant et révision doivent être présents ensemble.");
    const fields = nettoyerChamps(row);
    // nettoyerChamps ne conserve que les champs métier, jamais les métadonnées XLSX.
    const key = cleIdentite(fields);
    if (keys.has(key) || (row.id && ids.has(row.id))) throw new ConvexError("Doublons dans le fichier : import refusé.");
    keys.add(key);
    if (row.id) ids.add(row.id);
    const byKey = await trouver(ctx, saison, key);
    const existing = row.id ? await fiche(ctx, saison, row.id, row.revision!) : byKey;
    if (byKey && existing && byKey._id !== existing._id) throw new ConvexError("Cette identité est déjà utilisée.");
    const signature = row.partenariatSigne ?? existing?.partenariatSigne ?? false;
    const changed = existing ? champsModifies(existing, { ...fields, cleIdentite: key, partenariatSigne: signature }) : true;
    result.push({ row: { ...row, ...fields }, existingId: existing?._id ?? null, revision: existing?.revision ?? null, action: !existing ? "creation" : changed ? "modification" : "identique", before: existing ? { ...nettoyerChamps(existing), partenariatSigne: existing.partenariatSigne } : null });
  }
  return result;
}

export const previewImport = authenticatedQuery({
  args: { saison: v.string(), rows: v.array(importRowValidator) },
  returns: v.array(planValidator),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    return preparer(ctx, args.saison, args.rows);
  },
});

export const importRows = authenticatedMutation({
  args: { saison: v.string(), plans: v.array(planValidator) },
  returns: v.object({ created: v.number(), updated: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "competition");
    await verifierSaison(ctx, args.saison);
    const fresh = await preparer(ctx, args.saison, args.plans.map((p) => p.row));
    // Vérifier TOUTES les révisions avant les writes ; la mutation entière est atomique.
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i].existingId !== args.plans[i].existingId || fresh[i].revision !== args.plans[i].revision) throw new ConvexError("Conflit depuis la prévisualisation. Préparez à nouveau l'import.");
    }
    const result = { created: 0, updated: 0, unchanged: 0 };
    for (const plan of fresh) {
      const fields = nettoyerChamps(plan.row);
      let existing: Doc<"competition_ambassadeurs"> | null = null;
      if (plan.existingId) existing = await ctx.db.get(plan.existingId);
      const doc = { ...fields, saison: args.saison, cleIdentite: cleIdentite(fields), partenariatSigne: plan.row.partenariatSigne ?? existing?.partenariatSigne ?? false };
      if (!existing) {
        await ctx.db.insert("competition_ambassadeurs", { ...doc, revision: 1, updatedAt: Date.now(), updatedBy: ctx.userId });
        result.created++;
      } else if (champsModifies(existing, doc)) {
        await ctx.db.patch(existing._id, { ...doc, revision: existing.revision + 1, updatedAt: Date.now(), updatedBy: ctx.userId });
        result.updated++;
      } else result.unchanged++;
    }
    return result;
  },
});

// Bootstrap opérateur CLI uniquement : aucune attribution de droits, aucun remplacement.
export const bootstrapInitialSeason = internalMutation({
  args: { saison: v.literal("2026-27"), rows: v.array(importRowValidator) },
  returns: v.object({ created: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    await verifierSaison(ctx, args.saison);
    if (args.rows.length !== 27 || args.rows.some((r) => r.id !== undefined || r.revision !== undefined || r.partenariatSigne !== false || r.saison !== args.saison)) throw new ConvexError("Bootstrap réservé à 27 créations uniques non signées de 2026-27, sans identifiants.");
    const plans = await preparer(ctx, args.saison, args.rows);
    const existing = await ctx.db.query("competition_ambassadeurs").withIndex("by_saison", (q) => q.eq("saison", args.saison)).take(28);
    const expected = new Set(plans.map((p) => p.existingId).filter(Boolean));
    if (plans.some((p) => p.action === "modification") || existing.some((r) => !expected.has(r._id))) throw new ConvexError("Bootstrap refusé : données divergentes ou étrangères dans la saison.");
    let created = 0;
    for (const plan of plans) {
      if (plan.action !== "creation") continue;
      const fields = nettoyerChamps(plan.row);
      await ctx.db.insert("competition_ambassadeurs", { ...fields, saison: args.saison, cleIdentite: cleIdentite(fields), partenariatSigne: false, revision: 1, updatedAt: Date.now(), updatedSource: "bootstrap" });
      created++;
    }
    return { created, unchanged: 27 - created };
  },
});
