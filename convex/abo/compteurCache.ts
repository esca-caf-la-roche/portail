import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

// SAISON-EXEMPT: marqueur technique du cache courant, indépendant de la saison
// comptable. Il rend les recalculs planifiés idempotents et récupérables.
export const CLE_COMPTEUR_A_RECALCULER = "compteur_public_a_recalculer";

export async function invaliderCompteurPublic(ctx: MutationCtx): Promise<void> {
  const marqueur = await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first();
  if (!marqueur) {
    await ctx.db.insert("abo_app_config", {
      cle: CLE_COMPTEUR_A_RECALCULER,
      valeur: "true",
    });
  }
}

export async function programmerRafraichissementCompteurPublic(
  ctx: MutationCtx,
): Promise<void> {
  await invaliderCompteurPublic(ctx);
  await ctx.scheduler.runAfter(
    0,
    internal.abo.compteur.rafraichirCompteurPublic,
    { siNecessaire: true },
  );
}
