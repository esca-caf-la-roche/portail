import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireTile } from "./access";
import { authenticatedQuery as query } from "./customFunctions";
import { COEF_PREPARATION, HEURES_REUNION, toParametresPaie } from "./paie";
import { computePaie } from "../src/utils/paieCompute";

type CategorieCours = "mineurs" | "adultes" | "horsPerimetre";
type Ventilation = Record<CategorieCours, number>;
type HeuresPaie = { loisir: number; competition: number };

const categories: CategorieCours[] = ["mineurs", "adultes", "horsPerimetre"];

function zeroVentilation(): Ventilation {
  return { mineurs: 0, adultes: 0, horsPerimetre: 0 };
}

function arrondirCentimes(valeur: number): number {
  return Math.round((valeur + Number.EPSILON) * 100) / 100;
}

function categorieAnalytique(nom: string | undefined): CategorieCours {
  const code = nom?.trim().match(/^ESC0[12]\b/i)?.[0].toUpperCase();
  if (code === "ESC01") return "mineurs";
  if (code === "ESC02") return "adultes";
  return "horsPerimetre";
}

/** Calcule le coût employeur annuel de chaque salarié ayant des heures de cours. */
async function calculerCoutsAnnuelsParSalarie(
  ctx: QueryCtx,
  cours: Doc<"cours">[],
  parametres: Doc<"parametresPaie">,
  salaires: Doc<"salairesSaison">[],
): Promise<{
  coutsParSalarie: Map<Id<"salaries">, number>;
  heuresPaieParSalarie: Map<Id<"salaries">, HeuresPaie>;
  heuresTotalesParSalarie: Map<Id<"salaries">, number>;
  heuresTotalesPayeesParSalarie: Map<Id<"salaries">, number>;
}> {
  const heuresPaieParSalarie = new Map<Id<"salaries">, HeuresPaie>();
  const heuresTotalesParSalarie = new Map<Id<"salaries">, number>();

  for (const creneau of cours) {
    const heuresHebdomadaires = creneau.seances.reduce(
      (total, seance) => total + seance.dureeHeures,
      0,
    );
    for (const moniteur of creneau.moniteurs) {
      const heures = heuresHebdomadaires * moniteur.nbSemaines * COEF_PREPARATION;
      heuresTotalesParSalarie.set(
        moniteur.salarieId,
        (heuresTotalesParSalarie.get(moniteur.salarieId) ?? 0) + heures,
      );
      const heuresPaie = heuresPaieParSalarie.get(moniteur.salarieId) ?? { loisir: 0, competition: 0 };
      heuresPaie[creneau.competition ? "competition" : "loisir"] += heures;
      heuresPaieParSalarie.set(moniteur.salarieId, heuresPaie);
    }
  }

  const coutsParSalarie = new Map<Id<"salaries">, number>();
  const heuresTotalesPayeesParSalarie = new Map<Id<"salaries">, number>();
  const params = toParametresPaie(parametres);
  for (const salaire of salaires) {
    const heuresCoursSalarie = heuresTotalesParSalarie.get(salaire.salarieId) ?? 0;
    if (heuresCoursSalarie <= 0) continue;
    const salarie = await ctx.db.get(salaire.salarieId);
    const heuresPaie = heuresPaieParSalarie.get(salaire.salarieId) ?? { loisir: 0, competition: 0 };
    let heuresLoisir = heuresPaie.loisir + HEURES_REUNION;
    let heuresCompetition = heuresPaie.competition;
    for (const heuresSup of salaire.heuresSup ?? []) {
      if (heuresSup.competition) heuresCompetition += heuresSup.nbHeures;
      else heuresLoisir += heuresSup.nbHeures;
    }
    const nbHeuresAnnuel = Math.round(heuresLoisir) + Math.round(heuresCompetition);
    const paie = computePaie(
      {
        nom: salarie?.nom ?? "Inconnu",
        typeContrat: salarie?.typeContrat ?? "CDII",
        nbHeuresAnnuel,
        nbMois: salaire.nbMois,
        tauxHoraireBrut: salaire.tauxHoraireBrut,
      },
      params,
    );
    coutsParSalarie.set(salaire.salarieId, paie.coutAnnuel);
    heuresTotalesPayeesParSalarie.set(salaire.salarieId, nbHeuresAnnuel);
  }

  return {
    coutsParSalarie,
    heuresPaieParSalarie,
    heuresTotalesParSalarie,
    heuresTotalesPayeesParSalarie,
  };
}

/** Répartition des recettes et rentabilité des cours ESC01/ESC02 à capacité pleine. */
export const getRepartition = query({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");

    const [previsionnels, cours, parametres, salaires] = await Promise.all([
      ctx.db.query("previsionnels").withIndex("by_saison", (q) => q.eq("saison", args.saison)).collect(),
      ctx.db.query("cours").withIndex("by_saison", (q) => q.eq("saison", args.saison)).collect(),
      ctx.db.query("parametresPaie").withIndex("by_saison", (q) => q.eq("saison", args.saison)).first(),
      ctx.db.query("salairesSaison").withIndex("by_saison", (q) => q.eq("saison", args.saison)).collect(),
    ]);

    const analytiquesIds = new Set<Id<"analytiques">>();
    for (const ligne of previsionnels) analytiquesIds.add(ligne.analytiqueId);
    for (const creneau of cours) if (creneau.analytiqueId) analytiquesIds.add(creneau.analytiqueId);
    const analytiques = await Promise.all(
      [...analytiquesIds].map(async (id) => [id, await ctx.db.get(id)] as const),
    );
    const analytiqueNomById = new Map(analytiques.map(([id, analytique]) => [id, analytique?.nom]));

    const montantsParAnalytique = new Map<Id<"analytiques">, number>();
    for (const ligne of previsionnels) {
      if (ligne.montant <= 0) continue;
      montantsParAnalytique.set(
        ligne.analytiqueId,
        (montantsParAnalytique.get(ligne.analytiqueId) ?? 0) + ligne.montant,
      );
    }
    const recettes = [...montantsParAnalytique.entries()].map(([analytiqueId, montant]) => ({
      analytiqueId,
      analytiqueNom: analytiqueNomById.get(analytiqueId) ?? "Analytique supprimée",
      montant: arrondirCentimes(montant),
    }));
    recettes.sort(
      (a, b) => b.montant - a.montant || a.analytiqueNom.localeCompare(b.analytiqueNom, "fr"),
    );

    const recettesCours = zeroVentilation();
    const heuresCours = zeroVentilation();
    const participants = zeroVentilation();
    const nbCreneaux = { mineurs: 0, adultes: 0, horsPerimetre: 0 } satisfies Ventilation;
    const heuresParSalarie = new Map<Id<"salaries">, Ventilation>();
    const heuresPaieParSalarie = new Map<Id<"salaries">, HeuresPaie>();

    for (const creneau of cours) {
      const cible = categorieAnalytique(
        creneau.analytiqueId ? analytiqueNomById.get(creneau.analytiqueId) : undefined,
      );
      recettesCours[cible] += creneau.tarifAnnuel * creneau.nbElevesMax;
      participants[cible] += creneau.nbElevesMax;
      nbCreneaux[cible] += 1;
      const heuresHebdomadaires = creneau.seances.reduce(
        (total, seance) => total + seance.dureeHeures,
        0,
      );
      for (const moniteur of creneau.moniteurs) {
        const heures = heuresHebdomadaires * moniteur.nbSemaines * COEF_PREPARATION;
        heuresCours[cible] += heures;
        const ventilation = heuresParSalarie.get(moniteur.salarieId) ?? zeroVentilation();
        ventilation[cible] += heures;
        heuresParSalarie.set(moniteur.salarieId, ventilation);

        const heuresPaie = heuresPaieParSalarie.get(moniteur.salarieId) ?? { loisir: 0, competition: 0 };
        heuresPaie[creneau.competition ? "competition" : "loisir"] += heures;
        heuresPaieParSalarie.set(moniteur.salarieId, heuresPaie);
      }
    }

    // Les autres cours restent au dénominateur de la ventilation du coût complet.
    let couts: Ventilation | null = null;
    const salairesById = new Map(salaires.map((salaire) => [salaire.salarieId, salaire]));
    const moniteurCibleSansPaie = [...heuresParSalarie.entries()].some(
      ([salarieId, ventilation]) =>
        ventilation.mineurs + ventilation.adultes > 0 && !salairesById.has(salarieId),
    );
    if (parametres && !moniteurCibleSansPaie) {
      couts = zeroVentilation();
      const { coutsParSalarie, heuresTotalesParSalarie } = await calculerCoutsAnnuelsParSalarie(
        ctx,
        cours,
        parametres,
        salaires,
      );
      for (const [salarieId, coutAnnuel] of coutsParSalarie) {
        const ventilation = heuresParSalarie.get(salarieId) ?? zeroVentilation();
        const heuresCoursSalarie = heuresTotalesParSalarie.get(salarieId) ?? 0;
        if (heuresCoursSalarie <= 0) continue;
        for (const cible of categories) {
          couts[cible] += coutAnnuel * (ventilation[cible] / heuresCoursSalarie);
        }
      }
    }

    const detail = (cible: "mineurs" | "adultes") => {
      const recette = arrondirCentimes(recettesCours[cible]);
      const coutSalarial = couts ? arrondirCentimes(couts[cible]) : null;
      const resultat = coutSalarial === null ? null : arrondirCentimes(recette - coutSalarial);
      const nbParticipants = participants[cible];
      return {
        recette,
        coutSalarial,
        resultat,
        nbParticipants,
        resultatParParticipant:
          resultat !== null && nbParticipants > 0 ? arrondirCentimes(resultat / nbParticipants) : null,
        nbCreneaux: nbCreneaux[cible],
        heures: arrondirCentimes(heuresCours[cible]),
      };
    };

    return {
      recettes,
      totalRecettes: arrondirCentimes(recettes.reduce((total, recette) => total + recette.montant, 0)),
      cours: { mineurs: detail("mineurs"), adultes: detail("adultes") },
    };
  },
});

/** Synthèse par catégorie de cours pour la déclaration des écoles (FFCAM).
 *  Calcule les rentrées (tarif × capacité) et les sorties (coût employeur ventilé
 *  au prorata des heures de cours payées) en cohérence avec le prévisionnel. */
export const getDeclarationEcoles = query({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");

    const [cours, parametres, salaires] = await Promise.all([
      ctx.db.query("cours").withIndex("by_saison", (q) => q.eq("saison", args.saison)).collect(),
      ctx.db.query("parametresPaie").withIndex("by_saison", (q) => q.eq("saison", args.saison)).first(),
      ctx.db.query("salairesSaison").withIndex("by_saison", (q) => q.eq("saison", args.saison)).collect(),
    ]);

    const analytiquesIds = new Set<Id<"analytiques">>();
    const salariesIds = new Set<Id<"salaries">>();
    for (const creneau of cours) {
      if (creneau.analytiqueId) analytiquesIds.add(creneau.analytiqueId);
      for (const moniteur of creneau.moniteurs) salariesIds.add(moniteur.salarieId);
    }

    const [analytiques, salariesDocs] = await Promise.all([
      Promise.all([...analytiquesIds].map(async (id) => [id, await ctx.db.get(id)] as const)),
      Promise.all([...salariesIds].map(async (id) => [id, await ctx.db.get(id)] as const)),
    ]);
    const analytiqueNomById = new Map(analytiques.map(([id, a]) => [id, a?.nom ?? null]));
    const salarieNomById = new Map(salariesDocs.map(([id, s]) => [id, s?.nom ?? "Inconnu"]));

    const salairesById = new Map(salaires.map((s) => [s.salarieId, s]));
    const moniteursSansPaieIds = new Set<Id<"salaries">>();
    for (const salarieId of salariesIds) {
      if (!salairesById.has(salarieId)) moniteursSansPaieIds.add(salarieId);
    }

    const paieResult = parametres
      ? await calculerCoutsAnnuelsParSalarie(ctx, cours, parametres, salaires)
      : null;

    type Agg = {
      nom: string;
      analytiqueNom: string | null;
      estAdulte: boolean;
      competition: boolean;
      tarifAnnuel: number;
      nbCreneaux: number;
      nbCoursParSemaine: number;
      nbJeunes: number;
      recette: number;
      heures: number;
      moniteurIds: Set<Id<"salaries">>;
      heuresParSalarie: Map<Id<"salaries">, number>;
    };

    const parCategorie = new Map<string, Agg>();

    for (const creneau of cours) {
      const analytiqueNom = creneau.analytiqueId
        ? (analytiqueNomById.get(creneau.analytiqueId) ?? null)
        : null;
      const estAdulte = categorieAnalytique(analytiqueNom ?? undefined) === "adultes";
      const heuresHebdomadaires = creneau.seances.reduce(
        (total, seance) => total + seance.dureeHeures,
        0,
      );

      let agg = parCategorie.get(creneau.nom);
      if (!agg) {
        agg = {
          nom: creneau.nom,
          analytiqueNom,
          estAdulte,
          competition: Boolean(creneau.competition),
          tarifAnnuel: creneau.tarifAnnuel,
          nbCreneaux: 0,
          nbCoursParSemaine: creneau.seances.length,
          nbJeunes: 0,
          recette: 0,
          heures: 0,
          moniteurIds: new Set(),
          heuresParSalarie: new Map(),
        };
        parCategorie.set(creneau.nom, agg);
      } else {
        agg.competition = agg.competition || Boolean(creneau.competition);
        agg.estAdulte = agg.estAdulte && estAdulte;
        if (!agg.analytiqueNom && analytiqueNom) agg.analytiqueNom = analytiqueNom;
        if (creneau.seances.length > agg.nbCoursParSemaine) {
          agg.nbCoursParSemaine = creneau.seances.length;
        }
      }

      agg.nbCreneaux += 1;
      agg.nbJeunes += creneau.nbElevesMax;
      agg.recette += creneau.tarifAnnuel * creneau.nbElevesMax;

      for (const moniteur of creneau.moniteurs) {
        const heures = heuresHebdomadaires * moniteur.nbSemaines * COEF_PREPARATION;
        agg.heures += heures;
        agg.moniteurIds.add(moniteur.salarieId);
        agg.heuresParSalarie.set(
          moniteur.salarieId,
          (agg.heuresParSalarie.get(moniteur.salarieId) ?? 0) + heures,
        );
      }
    }

    const listeCategories = [...parCategorie.values()]
      .filter((agg) => !/autonomie/i.test(agg.nom))
      .map((agg) => {
        const recette = arrondirCentimes(agg.recette);
        const aMoniteurSansPaie = [...agg.moniteurIds].some((id) => moniteursSansPaieIds.has(id));

        let coutSalarial: number | null = null;
        if (paieResult && !aMoniteurSansPaie) {
          let sommeCout = 0;
          for (const [salarieId, heuresCat] of agg.heuresParSalarie) {
            const coutAnnuel = paieResult.coutsParSalarie.get(salarieId);
            const heuresTotalesPayees = paieResult.heuresTotalesPayeesParSalarie.get(salarieId) ?? 0;
            if (coutAnnuel !== undefined && heuresTotalesPayees > 0) {
              sommeCout += coutAnnuel * (heuresCat / heuresTotalesPayees);
            }
          }
          coutSalarial = arrondirCentimes(sommeCout);
        }

        const resultat = coutSalarial === null ? null : arrondirCentimes(recette - coutSalarial);
        const moniteursNoms = [...agg.moniteurIds]
          .map((id) => salarieNomById.get(id) ?? "Inconnu")
          .sort((a, b) => a.localeCompare(b, "fr"));

        return {
          nom: agg.nom,
          analytiqueNom: agg.analytiqueNom,
          estAdulte: agg.estAdulte,
          competition: agg.competition,
          tarifAnnuel: agg.tarifAnnuel,
          nbCreneaux: agg.nbCreneaux,
          nbCoursParSemaine: agg.nbCoursParSemaine,
          nbJeunes: agg.nbJeunes,
          nbEncadrants: agg.moniteurIds.size,
          moniteursNoms,
          heures: arrondirCentimes(agg.heures),
          recette,
          coutSalarial,
          resultat,
        };
      });

    listeCategories.sort(
      (a, b) =>
        Number(a.competition) - Number(b.competition) ||
        a.nom.localeCompare(b.nom, "fr"),
    );

    const moniteursSansPaie = [...moniteursSansPaieIds]
      .map((id) => salarieNomById.get(id) ?? "Inconnu")
      .sort((a, b) => a.localeCompare(b, "fr"));

    return {
      hasParametresPaie: Boolean(parametres),
      moniteursSansPaie,
      categories: listeCategories,
    };
  },
});
