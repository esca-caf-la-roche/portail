import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "./customFunctions";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { trouverLienAbo } from "./abo/paiements";
import { requireTile } from "./access";

// ─────────────────────────────────────────────────────────────────────────────
// HELLOASSO LINKS
// ─────────────────────────────────────────────────────────────────────────────

// Un lien appartient au module Abonnements s'il est marqué `type: "abonnement"`
// OU s'il correspond au lien actuellement configuré côté abo (self-heal pour
// les liens créés avant l'introduction du champ `type`). Ce côté (cours) ne
// doit jamais lire/modifier/supprimer ces liens ni leurs dossiers.
async function getAboLinkIds(
  ctx: QueryCtx | MutationCtx
): Promise<Set<Id<"helloasso_links">>> {
  const links = await ctx.db.query("helloasso_links").collect();
  const ids = new Set<Id<"helloasso_links">>();
  for (const l of links) {
    if (l.type === "abonnement") ids.add(l._id);
  }
  const cible = await trouverLienAbo(ctx);
  if (cible?.link) ids.add(cible.link._id);
  return ids;
}

export const getLinks = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const aboIds = await getAboLinkIds(ctx);
    const links = await ctx.db.query("helloasso_links").collect();
    return links.filter((l) => !aboIds.has(l._id));
  },
});

export const addLink = authenticatedMutation({
  args: {
    url: v.string(),
    label: v.string(),
    responsible_id: v.optional(v.id("users")),
    is_installment: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    return await ctx.db.insert("helloasso_links", {
      url: args.url,
      label: args.label,
      responsible_id: args.responsible_id,
      is_installment: args.is_installment,
    });
  },
});

export const updateLink = authenticatedMutation({
  args: {
    id: v.id("helloasso_links"),
    url: v.string(),
    label: v.string(),
    responsible_id: v.optional(v.id("users")),
    is_installment: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const { id, ...data } = args;
    if ((await getAboLinkIds(ctx)).has(id)) {
      throw new Error(
        "Ce lien appartient au formulaire abonnements : à gérer depuis Gestion abonnements."
      );
    }
    await ctx.db.patch(id, data);
  },
});

export const deleteLink = authenticatedMutation({
  args: { id: v.id("helloasso_links") },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    if ((await getAboLinkIds(ctx)).has(args.id)) {
      throw new Error(
        "Ce lien appartient au formulaire abonnements : à gérer depuis Gestion abonnements."
      );
    }
    // Cascade : liaisons de groupe
    const groupLinks = await ctx.db
      .query("group_links")
      .withIndex("by_link", (q) => q.eq("link_id", args.id))
      .collect();
    for (const gl of groupLinks) {
      await ctx.db.delete(gl._id);
    }

    // Cascade : dossiers + transactions rattachés à ce lien
    const dossiers = await ctx.db
      .query("dossiers")
      .withIndex("by_link", (q) => q.eq("helloasso_link_id", args.id))
      .collect();
    for (const d of dossiers) {
      const txs = await ctx.db
        .query("helloasso_transactions")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", d.dossier_id))
        .collect();
      for (const t of txs) {
        await ctx.db.delete(t._id);
      }
      await ctx.db.delete(d._id);
    }

    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUPS (+ group_links many-to-many)
// ─────────────────────────────────────────────────────────────────────────────

export const getGroups = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const groups = await ctx.db.query("groups").collect();
    const result = [];
    for (const g of groups) {
      const links = await ctx.db
        .query("group_links")
        .withIndex("by_group", (q) => q.eq("group_id", g._id))
        .collect();
      result.push({
        ...g,
        link_ids: links.map((l) => l.link_id),
      });
    }
    return result;
  },
});

export const addGroup = authenticatedMutation({
  args: {
    name: v.string(),
    requires_approval: v.boolean(),
    link_ids: v.array(v.id("helloasso_links")),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const groupId = await ctx.db.insert("groups", {
      name: args.name,
      requires_approval: args.requires_approval,
    });
    for (const linkId of args.link_ids) {
      await ctx.db.insert("group_links", { group_id: groupId, link_id: linkId });
    }
    return groupId;
  },
});

export const updateGroup = authenticatedMutation({
  args: {
    id: v.id("groups"),
    name: v.optional(v.string()),
    requires_approval: v.optional(v.boolean()),
    link_ids: v.optional(v.array(v.id("helloasso_links"))),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.requires_approval !== undefined)
      patch.requires_approval = args.requires_approval;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }

    // Remplacement complet des liaisons si link_ids fourni
    if (args.link_ids !== undefined) {
      const existing = await ctx.db
        .query("group_links")
        .withIndex("by_group", (q) => q.eq("group_id", args.id))
        .collect();
      for (const gl of existing) {
        await ctx.db.delete(gl._id);
      }
      for (const linkId of args.link_ids) {
        await ctx.db.insert("group_links", {
          group_id: args.id,
          link_id: linkId,
        });
      }
    }
  },
});

export const deleteGroup = authenticatedMutation({
  args: { id: v.id("groups") },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    // Cascade : liaisons de lien
    const groupLinks = await ctx.db
      .query("group_links")
      .withIndex("by_group", (q) => q.eq("group_id", args.id))
      .collect();
    for (const gl of groupLinks) {
      await ctx.db.delete(gl._id);
    }
    // Cascade : élèves approuvés de ce groupe
    const students = await ctx.db
      .query("approved_students")
      .withIndex("by_group", (q) => q.eq("group_id", args.id))
      .collect();
    for (const s of students) {
      await ctx.db.delete(s._id);
    }
    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSABLES (= staff ayant la tuile Paiements ; is_superuser = role admin)
// ─────────────────────────────────────────────────────────────────────────────

export const getResponsibles = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    // IO-BOUNDED: userSettings ne contient que le staff du club (moins de
    // 500 comptes attendus), contrairement à users qui contient aussi les
    // abonnés publics.
    const settings = await ctx.db.query("userSettings").collect();
    const responsibles = await Promise.all(
      settings
        .filter((staffSettings) =>
          staffSettings.allowedTiles.includes("paiements"),
        )
        .map(async (staffSettings) => {
          const user = await ctx.db.get(staffSettings.userId);
          if (!user) return null;
          return {
            id: user._id,
            name: user.name ?? user.email ?? "Sans nom",
            is_superuser: staffSettings.role === "admin",
          };
        }),
    );
    return responsibles.filter((responsible) => responsible !== null);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DOSSIERS (lecture enrichie + statuts locaux)
// ─────────────────────────────────────────────────────────────────────────────

export const getDossiers = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const aboIds = await getAboLinkIds(ctx);
    const dossiers = await ctx.db.query("dossiers").collect();
    const links = (await ctx.db.query("helloasso_links").collect()).filter(
      (l) => !aboIds.has(l._id)
    );
    const groups = await ctx.db.query("groups").collect();
    const groupLinks = await ctx.db.query("group_links").collect();

    const linksMap = new Map(links.map((l) => [l._id, l]));
    // link_id -> [group_id]
    const linkToGroups = new Map<
      Id<"helloasso_links">,
      Id<"groups">[]
    >();
    for (const gl of groupLinks) {
      const arr = linkToGroups.get(gl.link_id) ?? [];
      arr.push(gl.group_id);
      linkToGroups.set(gl.link_id, arr);
    }
    const groupsMap = new Map(groups.map((g) => [g._id, g]));

    const result = [];
    for (const d of dossiers) {
      const link = linksMap.get(d.helloasso_link_id);
      if (!link) continue;

      const transactions = await ctx.db
        .query("helloasso_transactions")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", d.dossier_id))
        .collect();
      transactions.sort((a, b) => a.payment_date.localeCompare(b.payment_date));

      const groupIds = linkToGroups.get(link._id) ?? [];
      const dossierGroups = groupIds
        .map((gid) => groupsMap.get(gid))
        .filter((g) => g !== undefined)
        .map((g) => ({
          id: g._id,
          name: g.name,
          requires_approval: g.requires_approval,
        }));

      const firstPaymentDate =
        transactions.length > 0
          ? transactions[0].payment_date
          : d.updated_at ?? new Date().toISOString();

      const has_status_mismatch =
        d.local_status === "Traité" &&
        transactions.some(
          (r) =>
            r.helloasso_status === "Refunded" ||
            r.helloasso_status === "Refused"
        );

      const isLocallyRefunded = d.local_status === "Remboursé";
      const totalPaid = transactions.reduce((s, t) => s + Number(t.amount), 0);
      const hasRefundTransaction = transactions.some((t) =>
        t.helloasso_payment_id.startsWith("refund-")
      );
      const isHARefunded =
        transactions.length > 0 &&
        (totalPaid <= 0 ||
          hasRefundTransaction ||
          transactions.every((r) => r.helloasso_status === "Refunded"));
      const needs_refund_action =
        (isLocallyRefunded && !isHARefunded) ||
        (!isLocallyRefunded && isHARefunded);

      result.push({
        id: d.dossier_id,
        helloasso_link_id: d.helloasso_link_id,
        link_url: link.url,
        responsible_id: link.responsible_id ?? null,
        is_installment: link.is_installment,
        payer_first_name: d.payer_first_name,
        payer_last_name: d.payer_last_name,
        payer_email: d.payer_email,
        first_name: d.first_name,
        last_name: d.last_name,
        email: d.email ?? null,
        phone: d.phone ?? null,
        first_payment_date: firstPaymentDate,
        total_amount: d.total_amount,
        groups: dossierGroups,
        transactions: transactions.map((t) => ({
          helloasso_payment_id: t.helloasso_payment_id,
          dossier_id: t.dossier_id,
          amount: t.amount,
          payment_date: t.payment_date,
          helloasso_status: t.helloasso_status,
          synced_at: t.synced_at,
          payment_receipt_url: t.payment_receipt_url ?? null,
          fiscal_receipt_url: t.fiscal_receipt_url ?? null,
        })),
        local_status: d.local_status ?? null,
        comment: d.comment ?? null,
        updated_by: d.updated_by ?? null,
        updated_at: d.updated_at ?? null,
        has_status_mismatch,
        needs_refund_action,
      });
    }

    result.sort((a, b) =>
      a.first_payment_date.localeCompare(b.first_payment_date)
    );
    return result;
  },
});

// Projection compacte partagée par les écrans Approbations et Attente. Ces
// écrans n'ont pas besoin de la timeline complète des transactions.
export const getDossiersTraitesIndex = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    payer_email: v.string(),
    email: v.union(v.string(), v.null()),
    first_name: v.string(),
    last_name: v.string(),
    group_ids: v.array(v.id("groups")),
  })),
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const aboIds = await getAboLinkIds(ctx);
    const dossiers = await ctx.db
      .query("dossiers")
      .withIndex("by_local_status", (q) => q.eq("local_status", "Traité"))
      .take(5_001);
    if (dossiers.length > 5_000) {
      throw new ConvexError({
        code: "54000",
        message: "Le nombre de dossiers traités dépasse la limite de sécurité.",
      });
    }
    const groupLinks = await ctx.db.query("group_links").take(1_001);
    if (groupLinks.length > 1_000) {
      throw new ConvexError({
        code: "54000",
        message: "Le nombre de liaisons de groupes dépasse la limite de sécurité.",
      });
    }
    const groupesParLien = new Map<Id<"helloasso_links">, Id<"groups">[]>();
    for (const relation of groupLinks) {
      const groupes = groupesParLien.get(relation.link_id) ?? [];
      groupes.push(relation.group_id);
      groupesParLien.set(relation.link_id, groupes);
    }

    return dossiers
      .filter((dossier) => !aboIds.has(dossier.helloasso_link_id))
      .map((dossier) => ({
        payer_email: dossier.payer_email,
        email: dossier.email ?? null,
        first_name: dossier.first_name,
        last_name: dossier.last_name,
        group_ids: groupesParLien.get(dossier.helloasso_link_id) ?? [],
      }));
  },
});

export const setDossierStatus = authenticatedMutation({
  args: {
    dossier_id: v.string(),
    status: v.string(),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const dossier = await ctx.db
      .query("dossiers")
      .withIndex("by_dossier_id", (q) => q.eq("dossier_id", args.dossier_id))
      .first();
    if (!dossier) throw new Error("Dossier introuvable");

    await ctx.db.patch(dossier._id, {
      local_status: args.status,
      comment: args.comment,
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    });
  },
});

export const resetDossierStatus = authenticatedMutation({
  args: { dossier_id: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const dossier = await ctx.db
      .query("dossiers")
      .withIndex("by_dossier_id", (q) => q.eq("dossier_id", args.dossier_id))
      .first();
    if (!dossier) throw new Error("Dossier introuvable");

    await ctx.db.patch(dossier._id, {
      local_status: undefined,
      comment: undefined,
      updated_by: undefined,
      updated_at: new Date().toISOString(),
    });
  },
});

export const resetSeason = authenticatedMutation({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const callerSettings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.userId))
      .first();
    if (callerSettings?.role !== "admin") {
      throw new Error("Seul un administrateur peut réinitialiser la saison.");
    }

    // Ne touche jamais aux dossiers/transactions du formulaire abonnements :
    // ce reset ne concerne que les paiements des cours.
    const aboIds = await getAboLinkIds(ctx);
    const dossiers = await ctx.db.query("dossiers").collect();
    for (const d of dossiers) {
      if (aboIds.has(d.helloasso_link_id)) continue;
      const txs = await ctx.db
        .query("helloasso_transactions")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", d.dossier_id))
        .collect();
      for (const t of txs) {
        await ctx.db.delete(t._id);
      }
      await ctx.db.delete(d._id);
    }

    await ctx.db.insert("season_resets", {
      reset_at: new Date().toISOString(),
      reset_by: ctx.userId,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ÉLÈVES APPROUVÉS (groupes sous approbation)
// ─────────────────────────────────────────────────────────────────────────────

export const getApprovedStudents = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const students = await ctx.db.query("approved_students").collect();
    return students.map((s) => ({
      id: s._id,
      first_name: s.first_name,
      last_name: s.last_name,
      email: s.email,
      group_id: s.group_id,
    }));
  },
});

export const addApprovedStudent = authenticatedMutation({
  args: {
    first_name: v.string(),
    last_name: v.string(),
    email: v.string(),
    group_id: v.id("groups"),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    return await ctx.db.insert("approved_students", {
      first_name: args.first_name,
      last_name: args.last_name,
      email: args.email.trim(),
      group_id: args.group_id,
    });
  },
});

export const updateApprovedStudent = authenticatedMutation({
  args: {
    id: v.id("approved_students"),
    first_name: v.string(),
    last_name: v.string(),
    email: v.string(),
    group_id: v.id("groups"),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const { id, ...data } = args;
    await ctx.db.patch(id, { ...data, email: data.email.trim() });
  },
});

export const deleteApprovedStudent = authenticatedMutation({
  args: { id: v.id("approved_students") },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// LISTE D'ATTENTE GÉNÉRALE
// ─────────────────────────────────────────────────────────────────────────────

export const getWaitingStudents = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const students = await ctx.db.query("waiting_students").collect();
    return students.map((s) => ({
      id: s._id,
      first_name: s.first_name,
      last_name: s.last_name,
      email: s.email,
    }));
  },
});

export const addWaitingStudent = authenticatedMutation({
  args: {
    first_name: v.string(),
    last_name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    return await ctx.db.insert("waiting_students", {
      first_name: args.first_name.trim(),
      last_name: args.last_name.trim(),
      email: args.email.trim(),
    });
  },
});

export const addWaitingStudentsBulk = authenticatedMutation({
  args: {
    students: v.array(
      v.object({
        first_name: v.string(),
        last_name: v.string(),
        email: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    let count = 0;
    for (const s of args.students) {
      await ctx.db.insert("waiting_students", {
        first_name: s.first_name.trim(),
        last_name: s.last_name.trim(),
        email: s.email.trim(),
      });
      count++;
    }
    return count;
  },
});

export const updateWaitingStudent = authenticatedMutation({
  args: {
    id: v.id("waiting_students"),
    first_name: v.string(),
    last_name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    const { id, ...data } = args;
    await ctx.db.patch(id, {
      first_name: data.first_name.trim(),
      last_name: data.last_name.trim(),
      email: data.email.trim(),
    });
  },
});

export const deleteWaitingStudent = authenticatedMutation({
  args: { id: v.id("waiting_students") },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "paiements");
    await ctx.db.delete(args.id);
  },
});
