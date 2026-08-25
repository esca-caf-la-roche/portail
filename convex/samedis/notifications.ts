import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { champsModifies } from "../dbUtils";
import { DESTINATAIRE_SYNTHESE, requireGestionnaire } from "./lib";

export const typeModificationValidator = v.union(
  v.literal("configuration_modifiee"),
  v.literal("participant_ajoute"),
  v.literal("participant_modifie"),
  v.literal("participant_supprime"),
  v.literal("creneau_modifie"),
  v.literal("reservation_creee"),
  v.literal("reservation_annulee"),
  v.literal("reservation_regularisee"),
  v.literal("calendrier_synchronise"),
);
export type TypeModification =
  | "configuration_modifiee"
  | "participant_ajoute"
  | "participant_modifie"
  | "participant_supprime"
  | "creneau_modifie"
  | "reservation_creee"
  | "reservation_annulee"
  | "reservation_regularisee"
  | "calendrier_synchronise";

export async function creerNotification(
  ctx: MutationCtx,
  args: {
    saison?: string;
    typeModification: TypeModification;
    acteurUserId: Id<"users">;
    resume: string;
  },
) {
  const now = Date.now();
  const notificationId = await ctx.db.insert("samedis_notifications", {
    saison: args.saison,
    typeModification: args.typeModification,
    acteurUserId: args.acteurUserId,
    resume: args.resume,
    destinataire: DESTINATAIRE_SYNTHESE,
    statut: "a_envoyer",
    tentatives: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.samedis.notifications.envoyer, {
    notificationId,
  });
  return notificationId;
}

export const contexte = internalQuery({
  args: { notificationId: v.id("samedis_notifications") },
  returns: v.union(
    v.null(),
    v.object({
      destinataire: v.string(),
      sujet: v.string(),
      texte: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.statut === "envoye") return null;
    const acteur = await ctx.db.get(notification.acteurUserId);
    const saison = notification.saison ? ` — saison ${notification.saison}` : "";
    return {
      destinataire: notification.destinataire,
      sujet: `Samedis après-midi : modification${saison}`,
      texte:
        `Une modification a été enregistrée dans la gestion des samedis après-midi.\n\n` +
        `Type : ${notification.typeModification}\n` +
        `Acteur : ${acteur?.email ?? notification.acteurUserId}\n` +
        `${notification.saison ? `Saison : ${notification.saison}\n` : ""}` +
        `Détail : ${notification.resume}\n` +
        `Date : ${new Date(notification.createdAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`,
    };
  },
});

export const marquerResultat = internalMutation({
  args: {
    notificationId: v.id("samedis_notifications"),
    succes: v.boolean(),
    erreur: v.optional(v.string()),
  },
  returns: v.object({ doitReessayer: v.boolean(), tentatives: v.number() }),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.statut === "envoye") {
      return { doitReessayer: false, tentatives: notification?.tentatives ?? 0 };
    }
    const tentatives = notification.tentatives + 1;
    const patch = args.succes
      ? { statut: "envoye" as const, tentatives, derniereErreur: undefined, updatedAt: Date.now() }
      : {
          statut: "echec" as const,
          tentatives,
          derniereErreur: (args.erreur ?? "Échec SMTP").slice(0, 500),
          updatedAt: Date.now(),
        };
    if (champsModifies(notification, patch, ["updatedAt"])) {
      await ctx.db.patch(notification._id, patch);
    }
    return { doitReessayer: !args.succes && tentatives < 3, tentatives };
  },
});

export const envoyer = internalAction({
  args: { notificationId: v.id("samedis_notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const donnees: { destinataire: string; sujet: string; texte: string } | null =
      await ctx.runQuery(internal.samedis.notifications.contexte, args);
    if (!donnees) return null;
    try {
      await ctx.runAction(internal.email.sendSamediEmail, {
        to: donnees.destinataire,
        subject: donnees.sujet,
        text: donnees.texte,
      });
      await ctx.runMutation(internal.samedis.notifications.marquerResultat, {
        ...args,
        succes: true,
      });
    } catch (cause) {
      const erreur = cause instanceof Error ? cause.message : "Échec SMTP";
      const resultat: { doitReessayer: boolean; tentatives: number } =
        await ctx.runMutation(internal.samedis.notifications.marquerResultat, {
          ...args,
          succes: false,
          erreur,
        });
      if (resultat.doitReessayer) {
        await ctx.scheduler.runAfter(
          60_000 * 2 ** (resultat.tentatives - 1),
          internal.samedis.notifications.envoyer,
          args,
        );
      }
    }
    return null;
  },
});

export const reessayer = authenticatedMutation({
  args: { notificationId: v.id("samedis_notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification) throw new ConvexError({ code: "SAMEDIS_NOTIFICATION_ABSENTE", message: "Notification introuvable." });
    if (notification.statut === "envoye") return null;
    const patch = { statut: "a_envoyer" as const, derniereErreur: undefined, updatedAt: Date.now() };
    if (champsModifies(notification, patch, ["updatedAt"])) await ctx.db.patch(notification._id, patch);
    await ctx.scheduler.runAfter(0, internal.samedis.notifications.envoyer, args);
    return null;
  },
});

export const listEchecs = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    _id: v.id("samedis_notifications"),
    saison: v.union(v.null(), v.string()),
    typeModification: typeModificationValidator,
    resume: v.string(),
    tentatives: v.number(),
    derniereErreur: v.union(v.null(), v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx) => {
    await requireGestionnaire(ctx, ctx.userId);
    return (await ctx.db
      .query("samedis_notifications")
      .withIndex("by_statut", (q) => q.eq("statut", "echec"))
      .order("desc")
      .take(50))
      .map((notification) => ({
        _id: notification._id,
        saison: notification.saison ?? null,
        typeModification: notification.typeModification,
        resume: notification.resume,
        tentatives: notification.tentatives,
        derniereErreur: notification.derniereErreur ?? null,
        createdAt: notification.createdAt,
        updatedAt: notification.updatedAt,
      }));
  },
});
