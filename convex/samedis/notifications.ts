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

const LIBELLES_MODIFICATION: Record<TypeModification, string> = {
  configuration_modifiee: "Configuration modifiée",
  participant_ajoute: "Participant ajouté",
  participant_modifie: "Participant modifié",
  participant_supprime: "Participant supprimé",
  creneau_modifie: "Créneau modifié",
  reservation_creee: "Réservation créée",
  reservation_annulee: "Réservation annulée",
  reservation_regularisee: "Réservation régularisée",
  calendrier_synchronise: "Calendrier synchronisé",
};

function capitaleInitiale(texte: string): string {
  return texte.length === 0 ? texte : `${texte[0]?.toUpperCase()}${texte.slice(1)}`;
}

export function formaterDateCivileFrancaise(dateIso: string): string {
  const correspondance = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!correspondance) return dateIso;
  const annee = Number(correspondance[1]);
  const mois = Number(correspondance[2]);
  const jour = Number(correspondance[3]);
  const date = new Date(Date.UTC(annee, mois - 1, jour, 12));
  if (
    date.getUTCFullYear() !== annee ||
    date.getUTCMonth() !== mois - 1 ||
    date.getUTCDate() !== jour
  ) {
    return dateIso;
  }
  return capitaleInitiale(new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date));
}

export function humaniserDatesDansTexte(texte: string): string {
  return texte.replace(/\b\d{4}-\d{2}-\d{2}\b/g, formaterDateCivileFrancaise);
}

export function echapperHtml(texte: string): string {
  return texte
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function construireEmailNotificationSamedis(args: {
  typeModification: TypeModification;
  acteur: string;
  saison?: string;
  resume: string;
  createdAt: number;
}) {
  const libelle = LIBELLES_MODIFICATION[args.typeModification];
  const detail = humaniserDatesDansTexte(args.resume);
  const dateEnregistrement = capitaleInitiale(new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(new Date(args.createdAt)));
  const sujet = `Samedis après-midi — ${libelle}${args.saison ? ` — saison ${args.saison}` : ""}`;
  const texte =
    `SAMEDIS APRÈS-MIDI\n\n` +
    `${libelle}\n${detail}\n\n` +
    `Acteur : ${args.acteur}\n` +
    `${args.saison ? `Saison : ${args.saison}\n` : ""}` +
    `Enregistré le : ${dateEnregistrement}`;

  const acteurHtml = echapperHtml(args.acteur);
  const saisonHtml = args.saison ? echapperHtml(args.saison) : null;
  const libelleHtml = echapperHtml(libelle);
  const detailHtml = echapperHtml(detail);
  const dateHtml = echapperHtml(dateEnregistrement);
  const html = `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:0;background:#e9e7ff;color:#111111;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#e9e7ff;">
      <tr>
        <td align="center" style="padding:32px 16px 44px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:4px solid #111111;box-shadow:10px 10px 0 #111111;">
            <tr>
              <td style="padding:14px 20px;background:#ffd84d;border-bottom:4px solid #111111;font-family:Arial Black,Arial,Helvetica,sans-serif;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;">
                CAF La Roche-Bonneville · Samedis après-midi
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 12px;">
                <div style="display:inline-block;padding:6px 10px;background:#111111;color:#ffffff;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Modification enregistrée</div>
                <h1 style="margin:16px 0 0;font-family:Arial Black,Arial,Helvetica,sans-serif;font-size:30px;line-height:1.1;text-transform:uppercase;">${libelleHtml}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 24px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#b9f56a;border:3px solid #111111;">
                  <tr>
                    <td style="padding:10px 14px;border-bottom:3px solid #111111;font-size:11px;font-weight:900;letter-spacing:1.2px;text-transform:uppercase;">Ce qui a changé</td>
                  </tr>
                  <tr>
                    <td style="padding:18px 14px;font-size:18px;line-height:1.45;font-weight:700;">${detailHtml}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:3px solid #111111;">
                  <tr>
                    <td width="34%" style="padding:11px 12px;background:#ff8fab;border-right:3px solid #111111;border-bottom:2px solid #111111;font-size:11px;font-weight:900;text-transform:uppercase;">Acteur</td>
                    <td style="padding:11px 12px;border-bottom:2px solid #111111;font-size:14px;font-weight:700;overflow-wrap:anywhere;">${acteurHtml}</td>
                  </tr>
                  ${saisonHtml ? `<tr>
                    <td width="34%" style="padding:11px 12px;background:#61dafb;border-right:3px solid #111111;border-bottom:2px solid #111111;font-size:11px;font-weight:900;text-transform:uppercase;">Saison</td>
                    <td style="padding:11px 12px;border-bottom:2px solid #111111;font-size:14px;font-weight:700;">${saisonHtml}</td>
                  </tr>` : ""}
                  <tr>
                    <td width="34%" style="padding:11px 12px;background:#ffd84d;border-right:3px solid #111111;font-size:11px;font-weight:900;text-transform:uppercase;">Enregistré le</td>
                    <td style="padding:11px 12px;font-size:14px;font-weight:700;">${dateHtml}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;background:#111111;color:#ffffff;font-size:11px;line-height:1.5;font-weight:700;">
                Notification automatique du portail Escalade CAF La Roche-Bonneville.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { sujet, texte, html };
}

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
      html: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.statut === "envoye") return null;
    const acteur = await ctx.db.get(notification.acteurUserId);
    const contenu = construireEmailNotificationSamedis({
      typeModification: notification.typeModification,
      acteur: acteur?.email ?? notification.acteurUserId,
      saison: notification.saison,
      resume: notification.resume,
      createdAt: notification.createdAt,
    });
    return {
      destinataire: notification.destinataire,
      ...contenu,
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
    const donnees: { destinataire: string; sujet: string; texte: string; html: string } | null =
      await ctx.runQuery(internal.samedis.notifications.contexte, args);
    if (!donnees) return null;
    try {
      await ctx.runAction(internal.email.sendSamediEmail, {
        to: donnees.destinataire,
        subject: donnees.sujet,
        text: donnees.texte,
        html: donnees.html,
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
