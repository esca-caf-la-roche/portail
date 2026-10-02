// Messagerie interne du module Abonnements (Phase K) : un fil par dossier,
// partagé entre l'abonné (owner) et les admins. Temps réel « gratuit » grâce à
// la réactivité des queries Convex (getFil se réabonne à chaque écriture).
//
// Portage de la table messages + RLS messages_* de abo-esca-new (jamais
// implémentée côté front dans la source : construite ici). Sécurité : chaque
// endpoint vérifie l'appartenance du dossier (owner) ou le rôle admin via
// requireOwnedDossier / requireAboAdmin. 🔒 Non-lu géré par 2 booléens.

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, ConvexError } from "convex/values";
import { authenticatedQuery, authenticatedMutation } from "../customFunctions";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { requireOwnedDossier, requireAboAdmin, getAboIdentity } from "./auth";
import type { Doc, Id } from "../_generated/dataModel";

const extrait = (contenu: string) => contenu.replace(/\s+/g, " ").trim().slice(0, 180);
const normaliserRecherche = (texte: string) => texte
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLocaleLowerCase("fr");

async function identiteDemandeur(ctx: MutationCtx, dossierId: Id<"abo_dossiers">) {
  const dossier = await ctx.db.get(dossierId);
  if (!dossier) throw new ConvexError({ code: "404", message: "Dossier introuvable." });
  const personne = await ctx.db
    .query("abo_personnes")
    .withIndex("by_dossier", (q) => q.eq("dossier_id", dossierId))
    .first();
  const nom = personne ? `${personne.prenom} ${personne.nom}`.trim() : dossier.email;
  return { nom, email: dossier.email };
}

async function mettreAJourConversation(
  ctx: MutationCtx,
  dossierId: Id<"abo_dossiers">,
  message: Pick<Doc<"abo_messages">, "auteur_role" | "contenu" | "_creationTime">,
) {
  const conversation = await ctx.db
    .query("abo_conversations")
    .withIndex("by_dossier", (q) => q.eq("dossier_id", dossierId))
    .first();
  const entrant = message.auteur_role === "utilisateur";
  if (conversation) {
    await ctx.db.patch(conversation._id, {
      statut: entrant ? "a_traiter" : conversation.statut,
      dernier_message_le: message._creationTime,
      dernier_message_auteur: message.auteur_role,
      dernier_message_extrait: extrait(message.contenu),
      messages_non_lus_admin: entrant
        ? conversation.messages_non_lus_admin + 1
        : conversation.messages_non_lus_admin,
      messages_non_lus_user: entrant
        ? conversation.messages_non_lus_user
        : conversation.messages_non_lus_user + 1,
    });
    return;
  }
  const demandeur = await identiteDemandeur(ctx, dossierId);
  await ctx.db.insert("abo_conversations", {
    dossier_id: dossierId,
    statut: entrant ? "a_traiter" : "cloturee",
    dernier_message_le: message._creationTime,
    dernier_message_auteur: message.auteur_role,
    dernier_message_extrait: extrait(message.contenu),
    demandeur_nom: demandeur.nom,
    demandeur_email: demandeur.email,
    recherche: normaliserRecherche(`${demandeur.nom} ${demandeur.email}`),
    messages_non_lus_admin: entrant ? 1 : 0,
    messages_non_lus_user: entrant ? 0 : 1,
  });
}

// ── envoyerMessage : owner ou admin poste dans le fil du dossier ─────────
export const envoyerMessage = authenticatedMutation({
  args: { dossierId: v.id("abo_dossiers"), contenu: v.string() },
  handler: async (ctx, args) => {
    const { identity } = await requireOwnedDossier(ctx, args.dossierId);
    const contenu = args.contenu.trim();
    if (!contenu) {
      throw new ConvexError({ code: "22023", message: "Message vide." });
    }
    if (contenu.length > 4000) {
      throw new ConvexError({ code: "22023", message: "Message trop long (4000 caractères max)." });
    }

    const estAdmin = identity.aboRole === "admin";
    const messageId = await ctx.db.insert("abo_messages", {
      dossier_id: args.dossierId,
      auteur_id: identity.userId,
      auteur_role: estAdmin ? "admin" : "utilisateur",
      contenu,
      // Le côté de l'auteur a « lu » son propre message ; l'autre côté ne l'a pas.
      lu_par_admin: estAdmin,
      lu_par_user: !estAdmin,
    });
    const message = await ctx.db.get(messageId);
    if (message) await mettreAJourConversation(ctx, args.dossierId, message);

    // Notification email de l'ABONNÉ quand un ADMIN écrit (l'abonné ne surveille
    // pas le tableau de bord). Le sens inverse (abonné → club) est signalé aux
    // admins par les badges non-lus temps réel du tableau de bord.
    if (estAdmin) {
      await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerEmailAbo, {
        dossierId: args.dossierId,
        typeEmail: "nouveau_message",
      });
    }
    return null;
  },
});

// ── getFil : messages d'un dossier (réactif = temps réel) ────────────────
export const getFil = authenticatedQuery({
  args: { dossierId: v.id("abo_dossiers") },
  handler: async (ctx, args) => {
    const { identity } = await requireOwnedDossier(ctx, args.dossierId);
    const messages = await ctx.db
      .query("abo_messages")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", args.dossierId))
      .collect();
    return messages
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((m) => ({
        id: m._id,
        auteur_role: m.auteur_role,
        contenu: m.contenu,
        created_at: m._creationTime,
        est_moi: m.auteur_id === identity.userId,
        lu_par_admin: m.lu_par_admin,
        lu_par_user: m.lu_par_user,
      }));
  },
});

// ── marquerLu : marque comme lus les messages de l'autre partie ──────────
// Appelé à l'ouverture du fil. L'admin marque lu_par_admin, l'owner lu_par_user.
export const marquerLu = authenticatedMutation({
  args: { dossierId: v.id("abo_dossiers") },
  handler: async (ctx, args) => {
    const { identity } = await requireOwnedDossier(ctx, args.dossierId);
    const estAdmin = identity.aboRole === "admin";
    const messages = await ctx.db
      .query("abo_messages")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", args.dossierId))
      .collect();
    let maj = 0;
    for (const m of messages) {
      if (estAdmin && !m.lu_par_admin) {
        await ctx.db.patch(m._id, { lu_par_admin: true });
        maj++;
      } else if (!estAdmin && !m.lu_par_user) {
        await ctx.db.patch(m._id, { lu_par_user: true });
        maj++;
      }
    }
    const conversation = await ctx.db
      .query("abo_conversations")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", args.dossierId))
      .first();
    if (conversation && (estAdmin ? conversation.messages_non_lus_admin > 0 : conversation.messages_non_lus_user > 0)) {
      await ctx.db.patch(conversation._id, estAdmin
        ? { messages_non_lus_admin: 0 }
        : { messages_non_lus_user: 0 });
    }
    return maj;
  },
});

// ── mesMessagesNonLus : compteur pour le badge de l'abonné (owner) ───────
export const mesMessagesNonLus = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await getAboIdentity(ctx);
    if (!identity) return 0;
    const dossier = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .first();
    if (!dossier) return 0;
    const messages = await ctx.db
      .query("abo_messages")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .collect();
    return messages.filter((m) => !m.lu_par_user).length;
  },
});

// ── messagesNonLusAdmin : nb de non-lus par dossier (badges admin) ───────
const conversationValidator = v.object({
  dossierId: v.id("abo_dossiers"),
  demandeurNom: v.string(),
  demandeurEmail: v.string(),
  statut: v.union(v.literal("a_traiter"), v.literal("cloturee")),
  dernierMessageLe: v.number(),
  dernierMessageAuteur: v.union(v.literal("utilisateur"), v.literal("admin")),
  dernierMessageExtrait: v.string(),
  messagesNonLusAdmin: v.number(),
});

export const listerConversationsAdmin = authenticatedQuery({
  args: {
    statut: v.union(v.literal("a_traiter"), v.literal("cloturee")),
    recherche: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(conversationValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const recherche = normaliserRecherche(args.recherche.trim());
    const query = recherche
      ? ctx.db.query("abo_conversations").withSearchIndex("search_recherche", (q) =>
        q.search("recherche", recherche).eq("statut", args.statut))
      : ctx.db.query("abo_conversations")
        .withIndex("by_statut_and_dernier_message_le", (q) => q.eq("statut", args.statut))
        .order("desc");
    const result = await query.paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((conversation) => ({
        dossierId: conversation.dossier_id,
        demandeurNom: conversation.demandeur_nom,
        demandeurEmail: conversation.demandeur_email,
        statut: conversation.statut,
        dernierMessageLe: conversation.dernier_message_le,
        dernierMessageAuteur: conversation.dernier_message_auteur,
        dernierMessageExtrait: conversation.dernier_message_extrait,
        messagesNonLusAdmin: conversation.messages_non_lus_admin,
      })),
    };
  },
});

// La campagne est limitée à 1 000 personnes suivies. Cette borne rend le
// compteur exact tout en évitant une lecture non bornée si la configuration
// d'une campagne devenait incohérente.
export const compterConversationsATraiter = authenticatedQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const conversations = await ctx.db
      .query("abo_conversations")
      .withIndex("by_statut_and_dernier_message_le", (q) => q.eq("statut", "a_traiter"))
      // IO-BOUNDED: une campagne Abonnements suit au maximum 1 000 personnes.
      .take(1_001);
    if (conversations.length > 1_000) {
      throw new ConvexError({
        code: "54000",
        message: "Le nombre de conversations à traiter dépasse la limite de 1 000.",
      });
    }
    return conversations.length;
  },
});

export const cloturerConversation = authenticatedMutation({
  args: { dossierId: v.id("abo_dossiers") },
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const conversation = await ctx.db
      .query("abo_conversations")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", args.dossierId))
      .first();
    if (!conversation) throw new ConvexError({ code: "404", message: "Conversation introuvable." });
    if (conversation.messages_non_lus_admin > 0) {
      throw new ConvexError({ code: "CONVERSATION_NON_LUE", message: "Lisez les nouveaux messages avant de clôturer la conversation." });
    }
    if (conversation.statut !== "cloturee") await ctx.db.patch(conversation._id, { statut: "cloturee" });
    return null;
  },
});

export const reouvrirConversation = authenticatedMutation({
  args: { dossierId: v.id("abo_dossiers") },
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const conversation = await ctx.db
      .query("abo_conversations")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", args.dossierId))
      .first();
    if (!conversation) throw new ConvexError({ code: "404", message: "Conversation introuvable." });
    if (conversation.statut !== "a_traiter") await ctx.db.patch(conversation._id, { statut: "a_traiter" });
    return null;
  },
});
