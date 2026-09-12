import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { champsModifies } from "../dbUtils";

// SAISON-EXEMPT: marqueur technique du cache courant, indépendant de la saison
// comptable. Il rend les recalculs planifiés idempotents et récupérables.
export const CLE_COMPTEUR_A_RECALCULER = "compteur_public_a_recalculer";
export const CLE_PROJECTION_ELEVES_COMPLETE = "projection_eleves_en_cours_complete";
const DELAI_REPRISE_PLANIFICATION_MS = 60_000;
const DELAI_REGROUPEMENT_COMPTEUR_MS = 5_000;

export type EleveEnCoursLecture = {
  source_eleve_id: Id<"abo_eleves_en_cours">;
  licence?: string;
  nom?: string;
  prenom?: string;
  nom_prenom_normalise: string;
  horaire?: string;
  cours?: string;
  saison_precedente?: string;
  email_eleve?: string;
  email_gestion?: string;
};

export function projeterEleveEnCours(
  eleve: Pick<
    Doc<"abo_eleves_en_cours">,
    | "_id"
    | "licence"
    | "nom"
    | "prenom"
    | "nom_prenom_normalise"
    | "horaire"
    | "cours"
    | "saison_precedente"
    | "email_eleve"
    | "email_gestion"
  >,
): EleveEnCoursLecture {
  return {
    source_eleve_id: eleve._id,
    licence: eleve.licence,
    nom: eleve.nom,
    prenom: eleve.prenom,
    nom_prenom_normalise: eleve.nom_prenom_normalise,
    horaire: eleve.horaire,
    cours: eleve.cours,
    saison_precedente: eleve.saison_precedente,
    email_eleve: eleve.email_eleve,
    email_gestion: eleve.email_gestion,
  };
}

export async function projectionElevesComplete(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  return (await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_PROJECTION_ELEVES_COMPLETE))
    .first()) !== null;
}

export async function lireElevesEnCoursCompacts(
  ctx: QueryCtx | MutationCtx,
  limite: number,
): Promise<EleveEnCoursLecture[]> {
  if (await projectionElevesComplete(ctx)) {
    return await ctx.db.query("abo_eleves_en_cours_lecture").take(limite);
  }
  const historiques = await ctx.db.query("abo_eleves_en_cours").take(limite);
  return historiques.map(projeterEleveEnCours);
}

export async function upsertProjectionEleveEnCours(
  ctx: MutationCtx,
  eleve: Parameters<typeof projeterEleveEnCours>[0],
): Promise<void> {
  const projection = projeterEleveEnCours(eleve);
  const existante = await ctx.db.query("abo_eleves_en_cours_lecture")
    .withIndex("by_source_eleve_id", (q) => q.eq("source_eleve_id", eleve._id))
    .unique();
  if (existante) {
    if (champsModifies(existante, projection)) {
      await ctx.db.replace(existante._id, projection);
    }
  } else {
    await ctx.db.insert("abo_eleves_en_cours_lecture", projection);
  }
}

export async function supprimerProjectionEleveEnCours(
  ctx: MutationCtx,
  sourceEleveId: Id<"abo_eleves_en_cours">,
): Promise<void> {
  const existante = await ctx.db.query("abo_eleves_en_cours_lecture")
    .withIndex("by_source_eleve_id", (q) => q.eq("source_eleve_id", sourceEleveId))
    .unique();
  if (existante) await ctx.db.delete(existante._id);
}

export async function invaliderCompteurPublic(ctx: MutationCtx): Promise<boolean> {
  const marqueur = await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first();
  if (!marqueur) {
    await ctx.db.insert("abo_app_config", {
      cle: CLE_COMPTEUR_A_RECALCULER,
      valeur: "true",
      updated_at: new Date().toISOString(),
    });
    return true;
  }
  return false;
}

export async function programmerRafraichissementCompteurPublic(
  ctx: MutationCtx,
): Promise<void> {
  const maintenant = Date.now();
  const marqueur = await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first();
  const planificationRecente = marqueur?.valeur === "planifie" &&
    marqueur.updated_at !== undefined &&
    maintenant - Date.parse(marqueur.updated_at) < DELAI_REPRISE_PLANIFICATION_MS;
  if (planificationRecente) return;

  const planification = {
    valeur: "planifie",
    updated_at: new Date(maintenant).toISOString(),
  };
  if (marqueur) await ctx.db.patch(marqueur._id, planification);
  else await ctx.db.insert("abo_app_config", {
    cle: CLE_COMPTEUR_A_RECALCULER,
    ...planification,
  });
  await ctx.scheduler.runAfter(
    DELAI_REGROUPEMENT_COMPTEUR_MS,
    internal.abo.compteur.rafraichirCompteurPublic,
    { siNecessaire: true },
  );
}
