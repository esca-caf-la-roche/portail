import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { champsModifies } from "../dbUtils";

// SAISON-EXEMPT: marqueur technique du cache courant, indépendant de la saison
// comptable. Il rend les recalculs planifiés idempotents et récupérables.
export const CLE_COMPTEUR_A_RECALCULER = "compteur_public_a_recalculer";
// La version fait retomber automatiquement les lectures sur la source pendant
// l'enrichissement d'une projection déjà remplie par une version antérieure.
// v4 ajoute `a_verifier_licence`. Tant que le backfill n'a pas validé cette
// version, les lecteurs retombent sur la source : un index partiellement
// rempli ne doit jamais faire disparaître un élève à contrôler.
export const CLE_PROJECTION_ELEVES_COMPLETE = "projection_eleves_en_cours_complete_v4";
const DELAI_REGROUPEMENT_COMPTEUR_MS = 5_000;
const PLANIFICATION_COMPTEUR_PREFIXE = "planifie:";

export type EleveEnCoursLecture = {
  source_eleve_id: Id<"abo_eleves_en_cours">;
  licence?: string;
  nom?: string;
  prenom?: string;
  date_naissance?: string;
  licence_saison?: string;
  nom_prenom_normalise: string;
  horaire?: string;
  cours?: string;
  saison_precedente?: string;
  email_eleve?: string;
  email_gestion?: string;
  a_verifier_licence?: boolean;
};

export function projeterEleveEnCours(
  eleve: Pick<
    Doc<"abo_eleves_en_cours">,
    | "_id"
    | "licence"
    | "nom"
    | "prenom"
    | "date_naissance"
    | "licence_saison"
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
    date_naissance: eleve.date_naissance,
    licence_saison: eleve.licence_saison,
    nom_prenom_normalise: eleve.nom_prenom_normalise,
    horaire: eleve.horaire,
    cours: eleve.cours,
    saison_precedente: eleve.saison_precedente,
    email_eleve: eleve.email_eleve,
    email_gestion: eleve.email_gestion,
    a_verifier_licence:
      eleve.horaire !== "Liste d'attente" &&
      (eleve.licence_saison ?? "").trim().toLocaleLowerCase("fr") !== "ok",
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
    await programmerRafraichissementCompteurPublic(ctx);
    return true;
  }
  // Même si le cache est déjà marqué sale, chaque écriture repousse l'exécution
  // à la fin de la rafale. Ainsi un import découpé en lots ne déclenche pas un
  // calcul complet au milieu de ses propres écritures.
  await programmerRafraichissementCompteurPublic(ctx);
  return false;
}

export async function programmerRafraichissementCompteurPublic(
  ctx: MutationCtx,
): Promise<void> {
  const marqueur = await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first();
  const morceaux = marqueur?.valeur?.split(":") ?? [];
  const versionPrecedente = morceaux[0] === "planifie" && /^\d+$/.test(morceaux[1] ?? "")
    ? Number(morceaux[1])
    : 0;
  if (morceaux[0] === "planifie") {
    const planificationId = (morceaux.length >= 3 ? morceaux[2] : morceaux[1]) as Id<"_scheduled_functions">;
    const planification = await ctx.db.system.get("_scheduled_functions", planificationId);
    if (planification?.state.kind === "pending" && marqueur) {
      // Un seul callback reste en attente. Sa version deviendra obsolète et il
      // reprogrammera exactement une exécution après la rafale si nécessaire.
      const version = versionPrecedente + 1;
      await ctx.db.patch(marqueur._id, {
        valeur: `${PLANIFICATION_COMPTEUR_PREFIXE}${version}:${planificationId}`,
        updated_at: new Date().toISOString(),
      });
      return;
    } else if (planification?.state.kind === "inProgress") {
      // L'exécution en cours porte une version différente : elle verra le
      // marqueur remplacé et s'arrêtera avant de vider une invalidation récente.
    } else if (!planification) {
      // Un marqueur historique malformé ne doit pas bloquer le prochain calcul.
    }
  }
  const version = versionPrecedente + 1;
  const planificationId = await ctx.scheduler.runAfter(
    DELAI_REGROUPEMENT_COMPTEUR_MS,
    internal.abo.compteur.rafraichirCompteurPublic,
    { siNecessaire: true, version },
  );
  const planification = {
    valeur: `${PLANIFICATION_COMPTEUR_PREFIXE}${version}:${planificationId}`,
    updated_at: new Date().toISOString(),
  };
  if (marqueur) {
    await ctx.db.patch(marqueur._id, planification);
  } else {
    await ctx.db.insert("abo_app_config", {
      cle: CLE_COMPTEUR_A_RECALCULER,
      ...planification,
    });
  }
}
