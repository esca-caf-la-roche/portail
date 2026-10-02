import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const CLE_COMPTEUR = "global" as const;

type CompteurCtx = Pick<MutationCtx, "db">;

async function lireCompteur(ctx: Pick<QueryCtx, "db">) {
  return await ctx.db
    .query("abo_conversations_compteur")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR))
    .unique();
}

async function assurerCompteurEnBackfill(ctx: CompteurCtx) {
  const compteur = await lireCompteur(ctx);
  if (compteur) return compteur;
  const compteurId = await ctx.db.insert("abo_conversations_compteur", {
    cle: CLE_COMPTEUR,
    etat: "backfill",
    a_traiter: 0,
  });
  return await ctx.db.get(compteurId);
}

async function modifierCompteur(ctx: CompteurCtx, delta: number) {
  if (delta === 0) return;
  const compteur = await assurerCompteurEnBackfill(ctx);
  if (!compteur) {
    throw new ConvexError({ code: "COMPTEUR_ABSENT", message: "Compteur de conversations introuvable." });
  }
  const suivant = compteur.a_traiter + delta;
  if (suivant < 0) {
    throw new ConvexError({ code: "COMPTEUR_INCOHERENT", message: "Compteur de conversations incohérent." });
  }
  await ctx.db.patch(compteur._id, { a_traiter: suivant });
}

/** Toute nouvelle projection est comptée immédiatement, même durant le backfill. */
export async function ajouterConversationAuCompteur(
  ctx: CompteurCtx,
  statut: Doc<"abo_conversations">["statut"],
) {
  await assurerCompteurEnBackfill(ctx);
  if (statut === "a_traiter") await modifierCompteur(ctx, 1);
}

/** Les conversations historiques non marquées seront prises en compte par migration. */
export async function ajusterCompteurChangementStatut(
  ctx: CompteurCtx,
  conversation: Doc<"abo_conversations">,
  statutSuivant: Doc<"abo_conversations">["statut"],
) {
  if (
    !conversation.compteur_a_traiter_inclus ||
    conversation.statut === statutSuivant
  ) return;
  await modifierCompteur(
    ctx,
    (statutSuivant === "a_traiter" ? 1 : 0) -
      (conversation.statut === "a_traiter" ? 1 : 0),
  );
}

export async function retirerConversationDuCompteur(
  ctx: CompteurCtx,
  conversation: Doc<"abo_conversations">,
) {
  if (conversation.compteur_a_traiter_inclus && conversation.statut === "a_traiter") {
    await modifierCompteur(ctx, -1);
  }
}

/** Inclut atomiquement une ligne historique dans le compteur pendant le backfill. */
export async function inclureConversationHistoriqueDansCompteur(
  ctx: CompteurCtx,
  conversation: Doc<"abo_conversations">,
) {
  if (conversation.compteur_a_traiter_inclus) return;
  await assurerCompteurEnBackfill(ctx);
  if (conversation.statut === "a_traiter") await modifierCompteur(ctx, 1);
  await ctx.db.patch(conversation._id, { compteur_a_traiter_inclus: true });
}
