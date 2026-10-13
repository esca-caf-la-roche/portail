import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "./customFunctions";
import { getUserSettings, requireTile } from "./access";
import { champsModifies } from "./dbUtils";
import { canoniserEmailUnique } from "./emailValidation";
import { contenuTache, destinatairesNotifies, statutTache, tacheDoc } from "./tachesModel";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

async function exigerSaison(ctx: QueryCtx, saison: string) {
  if (!await ctx.db.query("saisons").withIndex("by_nom", q => q.eq("nom", saison)).first()) {
    throw new ConvexError("Saison introuvable.");
  }
}

async function exigerTache(ctx: QueryCtx, id: Id<"taches">, saison: string) {
  const tache = await ctx.db.get(id);
  if (!tache || tache.saison !== saison) throw new ConvexError("Tâche introuvable pour cette saison.");
  return tache;
}

function exigerCreateur(tache: Doc<"taches">, userId: Id<"users">) {
  if (tache.createurId !== userId) throw new ConvexError("Seul le créateur peut modifier ou supprimer cette tâche.");
}

async function validerContenu(ctx: MutationCtx, args: {
  titre: string; description?: string; echeance?: string; assigneIds: Id<"users">[];
}) {
  const titre = args.titre.trim();
  if (!titre || titre.length > 160) throw new ConvexError("Le titre doit contenir entre 1 et 160 caractères.");
  if ((args.description?.length ?? 0) > 4000) throw new ConvexError("La description est limitée à 4000 caractères.");
  if (args.echeance !== undefined) {
    const date = new Date(`${args.echeance}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.echeance) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== args.echeance) {
      throw new ConvexError("L'échéance doit être une date valide au format AAAA-MM-JJ.");
    }
  }
  if (args.assigneIds.length < 1 || args.assigneIds.length > 50 || new Set(args.assigneIds).size !== args.assigneIds.length) {
    throw new ConvexError("Sélectionnez entre 1 et 50 membres du staff distincts.");
  }
  for (const userId of args.assigneIds) {
    if (!await getUserSettings(ctx, userId) || !await ctx.db.get(userId)) throw new ConvexError("Chaque assigné doit être un membre du staff existant.");
  }
  return { titre, description: args.description?.trim() || undefined, echeance: args.echeance, assigneIds: [...args.assigneIds].sort() };
}

async function assignations(ctx: QueryCtx, id: Id<"taches">) {
  const rows = await ctx.db.query("taches_assignations").withIndex("by_tacheId", q => q.eq("tacheId", id)).take(51);
  if (rows.length > 50) throw new ConvexError("Trop d'assignations pour cette tâche.");
  return rows;
}

// Prévient par e-mail les personnes nouvellement assignées. L'appelant a déjà
// retiré l'auteur de la tâche : on ne notifie jamais quelqu'un qui s'assigne
// lui-même. Les envois sont planifiés (jamais bloquants) et chaque destinataire
// sans adresse est simplement ignoré.
async function notifierNouveauxAssignes(
  ctx: MutationCtx,
  tache: { createurId: Id<"users">; titre: string; description?: string; echeance?: string; saison: string },
  destinataires: Id<"users">[],
) {
  if (destinataires.length === 0) return;
  const createur = await ctx.db.get(tache.createurId);
  const nomCreateur = createur?.name?.trim() || "Un membre du staff";
  const parties = [`${nomCreateur} vous a assigné la tâche « ${tache.titre} » (saison ${tache.saison}).`];
  if (tache.echeance) parties.push(`Échéance : ${tache.echeance.split("-").reverse().join("/")}.`);
  if (tache.description) parties.push(`Description :\n${tache.description}`);
  const texte = `${parties.join("\n")}\n\nConnectez-vous au portail, tuile Tâches, pour la consulter et suivre son avancement.`;
  const titreSujet = tache.titre.replace(/[\r\n]+/g, " ").trim();
  for (const userId of destinataires) {
    const user = await ctx.db.get(userId);
    let email: string;
    try {
      email = canoniserEmailUnique(user?.email ?? "");
    } catch {
      // Adresse historique non canonique : on n'planifie pas d'envoi condamné.
      continue;
    }
    await ctx.scheduler.runAfter(0, internal.email.sendTacheEmail, {
      to: email,
      sujet: `Nouvelle tâche assignée : ${titreSujet}`,
      texte,
    });
  }
}

export const list = authenticatedQuery({
  args: { saison: v.string(), paginationOpts: paginationOptsValidator, statut: v.optional(statutTache), assigneId: v.optional(v.id("users")) },
  returns: paginationResultValidator(tacheDoc),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "taches");
    if (!Number.isInteger(args.paginationOpts.numItems) || args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 25) throw new ConvexError("Une page contient au maximum 25 tâches.");
    const { saison, statut, assigneId } = args;
    if (assigneId) {
      const query = statut
        ? ctx.db.query("taches_assignations").withIndex("by_saison_and_userId_and_statut", q => q.eq("saison", saison).eq("userId", assigneId).eq("statut", statut))
        : ctx.db.query("taches_assignations").withIndex("by_saison_and_userId", q => q.eq("saison", saison).eq("userId", assigneId));
      const result = await query.order("desc").paginate(args.paginationOpts);
      const page = await Promise.all(result.page.map(row => exigerTache(ctx, row.tacheId, saison)));
      return { ...result, page };
    }
    const query = statut
      ? ctx.db.query("taches").withIndex("by_saison_and_statut", q => q.eq("saison", saison).eq("statut", statut))
      : ctx.db.query("taches").withIndex("by_saison", q => q.eq("saison", saison));
    return await query.order("desc").paginate(args.paginationOpts);
  },
});

export const annuaireStaff = authenticatedQuery({
  args: {}, returns: v.array(v.object({ userId: v.id("users"), nom: v.string() })),
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "taches");
    // IO-BOUNDED: annuaire staff uniquement, 500 comptes maximum + sentinelle.
    const settings = await ctx.db.query("userSettings").take(501);
    if (settings.length > 500) throw new ConvexError("L'annuaire dépasse 500 membres : une pagination est nécessaire.");
    const users = await Promise.all(settings.map(async s => {
      const user = await ctx.db.get(s.userId);
      return user ? { userId: user._id, nom: user.name?.trim() || "Membre sans nom" } : null;
    }));
    return users.filter(u => u !== null).sort((a, b) => a.nom.localeCompare(b.nom));
  },
});

export const create = authenticatedMutation({
  args: contenuTache.extend({ saison: v.string() }).fields, returns: v.id("taches"),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "taches");
    await exigerSaison(ctx, args.saison);
    const contenu = await validerContenu(ctx, args);
    const id = await ctx.db.insert("taches", { ...contenu, saison: args.saison, createurId: ctx.userId, statut: "a_faire", updatedAt: Date.now() });
    for (const userId of contenu.assigneIds) await ctx.db.insert("taches_assignations", { saison: args.saison, tacheId: id, userId, statut: "a_faire" });
    await notifierNouveauxAssignes(
      ctx,
      { createurId: ctx.userId, titre: contenu.titre, description: contenu.description, echeance: contenu.echeance, saison: args.saison },
      destinatairesNotifies([], contenu.assigneIds, ctx.userId),
    );
    return id;
  },
});

export const update = authenticatedMutation({
  args: contenuTache.extend({ id: v.id("taches"), saison: v.string() }).fields, returns: v.null(),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "taches");
    const tache = await exigerTache(ctx, args.id, args.saison);
    exigerCreateur(tache, ctx.userId);
    const contenu = await validerContenu(ctx, args);
    const changedAssignments = contenu.assigneIds.join() !== tache.assigneIds.join();
    if (changedAssignments) {
      const rows = await assignations(ctx, tache._id);
      for (const row of rows) if (!contenu.assigneIds.includes(row.userId)) await ctx.db.delete(row._id);
      for (const userId of contenu.assigneIds) if (!rows.some(row => row.userId === userId)) {
        await ctx.db.insert("taches_assignations", { saison: tache.saison, tacheId: tache._id, userId, statut: tache.statut });
      }
    }
    if (champsModifies(tache, contenu, ["assigneIds"]) || changedAssignments) await ctx.db.patch(tache._id, { ...contenu, updatedAt: Date.now() });
    await notifierNouveauxAssignes(
      ctx,
      { createurId: tache.createurId, titre: contenu.titre, description: contenu.description, echeance: contenu.echeance, saison: tache.saison },
      destinatairesNotifies(tache.assigneIds, contenu.assigneIds, ctx.userId),
    );
    return null;
  },
});

export const setStatus = authenticatedMutation({
  args: { id: v.id("taches"), saison: v.string(), statut: statutTache }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "taches");
    const tache = await exigerTache(ctx, args.id, args.saison);
    if (tache.createurId !== ctx.userId && !tache.assigneIds.includes(ctx.userId)) throw new ConvexError("Seuls le créateur et les assignés peuvent changer le statut.");
    if (champsModifies(tache, { statut: args.statut })) {
      await ctx.db.patch(tache._id, { statut: args.statut, updatedAt: Date.now() });
      for (const row of await assignations(ctx, tache._id)) if (champsModifies(row, { statut: args.statut })) await ctx.db.patch(row._id, { statut: args.statut });
    }
    return null;
  },
});

export const remove = authenticatedMutation({
  args: { id: v.id("taches"), saison: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "taches");
    const tache = await exigerTache(ctx, args.id, args.saison);
    exigerCreateur(tache, ctx.userId);
    for (const row of await assignations(ctx, tache._id)) await ctx.db.delete(row._id);
    await ctx.db.delete(tache._id);
    return null;
  },
});
