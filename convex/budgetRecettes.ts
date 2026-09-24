import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTile } from "./access";
import { authenticatedQuery as query } from "./customFunctions";
import { COEF_PREPARATION, HEURES_REUNION, toParametresPaie } from "./paie";
import { computePaie } from "../src/utils/paieCompute";

type PublicCible = "mineurs" | "adultes" | "nonClasses";
type Ventilation = Record<PublicCible, number>;
type HeuresPaie = { loisir: number; competition: number };

const categories: PublicCible[] = ["mineurs", "adultes", "nonClasses"];

function zeroVentilation(): Ventilation {
  return { mineurs: 0, adultes: 0, nonClasses: 0 };
}

function arrondirCentimes(valeur: number): number {
  return Math.round((valeur + Number.EPSILON) * 100) / 100;
}

function categorieCours(cours: Doc<"cours">): PublicCible {
  return cours.publicCible ?? "nonClasses";
}

/**
 * Répartition des recettes prévisionnelles et rentabilité des cours par public.
 * Les lectures sont bornées à la saison demandée via les index saisonniers.
 */
export const getRepartition = query({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");

    const [previsionnels, cours, effectifs, parametres, salaires] = await Promise.all([
      ctx.db
        .query("previsionnels")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .collect(),
      ctx.db
        .query("cours")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .collect(),
      ctx.db
        .query("budgetEffectifs")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .first(),
      ctx.db
        .query("parametresPaie")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .first(),
      ctx.db
        .query("salairesSaison")
        .withIndex("by_saison", (q) => q.eq("saison", args.saison))
        .collect(),
    ]);

    // Camembert : uniquement les recettes strictement positives, regroupées par
    // analytique, y compris les lignes manuelles du prévisionnel.
    const montantsParAnalytique = new Map<Id<"analytiques">, number>();
    for (const ligne of previsionnels) {
      if (ligne.montant <= 0) continue;
      montantsParAnalytique.set(
        ligne.analytiqueId,
        (montantsParAnalytique.get(ligne.analytiqueId) ?? 0) + ligne.montant,
      );
    }
    const recettes = await Promise.all(
      [...montantsParAnalytique.entries()].map(async ([analytiqueId, montant]) => {
        const analytique = await ctx.db.get(analytiqueId);
        return {
          analytiqueId,
          analytiqueNom: analytique?.nom ?? "Analytique supprimée",
          montant: arrondirCentimes(montant),
        };
      }),
    );
    recettes.sort((a, b) => b.montant - a.montant || a.analytiqueNom.localeCompare(b.analytiqueNom, "fr"));

    const recettesCours = zeroVentilation();
    const heuresCours = zeroVentilation();
    const nbCreneaux: Record<PublicCible, number> = {
      mineurs: 0,
      adultes: 0,
      nonClasses: 0,
    };
    const heuresParSalarie = new Map<Id<"salaries">, Ventilation>();
    const heuresPaieParSalarie = new Map<Id<"salaries">, HeuresPaie>();

    for (const creneau of cours) {
      const cible = categorieCours(creneau);
      recettesCours[cible] += creneau.tarifAnnuel * creneau.nbElevesMax;
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

        const heuresPaie = heuresPaieParSalarie.get(moniteur.salarieId) ?? {
          loisir: 0,
          competition: 0,
        };
        heuresPaie[creneau.competition ? "competition" : "loisir"] += heures;
        heuresPaieParSalarie.set(moniteur.salarieId, heuresPaie);
      }
    }

    // Une paie incomplète ne doit pas produire un faux coût nul. Quand elle est
    // disponible, le coût complet de chaque salarié est ventilé selon ses heures
    // de cours (préparation comprise) dans chaque public.
    let couts: Ventilation | null = null;
    const totalHeuresVentilables = categories.reduce(
      (total, cible) => total + heuresCours[cible],
      0,
    );
    const salairesById = new Map(salaires.map((salaire) => [salaire.salarieId, salaire]));
    const moniteurSansPaie = [...heuresParSalarie.keys()].some(
      (salarieId) => !salairesById.has(salarieId),
    );
    if (
      parametres &&
      salaires.length > 0 &&
      totalHeuresVentilables > 0 &&
      !moniteurSansPaie
    ) {
      couts = zeroVentilation();
      const params = toParametresPaie(parametres);
      for (const salaire of salaires) {
        const ventilation = heuresParSalarie.get(salaire.salarieId) ?? zeroVentilation();
        const heuresCoursSalarie = categories.reduce(
          (total, cible) => total + ventilation[cible],
          0,
        );
        if (heuresCoursSalarie <= 0) continue;
        const salarie = await ctx.db.get(salaire.salarieId);
        const heuresPaie = heuresPaieParSalarie.get(salaire.salarieId) ?? {
          loisir: 0,
          competition: 0,
        };
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
        for (const cible of categories) {
          couts[cible] += paie.coutAnnuel * (ventilation[cible] / heuresCoursSalarie);
        }
      }
    }

    const detail = (cible: PublicCible, nbParticipants: number | null) => {
      const recette = arrondirCentimes(recettesCours[cible]);
      const coutSalarial = couts ? arrondirCentimes(couts[cible]) : null;
      const resultat = coutSalarial === null ? null : arrondirCentimes(recette - coutSalarial);
      return {
        recette,
        coutSalarial,
        resultat,
        nbParticipants,
        resultatParParticipant:
          resultat !== null && nbParticipants !== null && nbParticipants > 0
            ? arrondirCentimes(resultat / nbParticipants)
            : null,
        nbCreneaux: nbCreneaux[cible],
        heures: arrondirCentimes(heuresCours[cible]),
      };
    };

    return {
      recettes,
      totalRecettes: arrondirCentimes(recettes.reduce((total, recette) => total + recette.montant, 0)),
      cours: {
        mineurs: detail("mineurs", effectifs?.nbMineursCours ?? null),
        adultes: detail("adultes", effectifs?.nbAdultesCours ?? null),
        nonClasses: detail("nonClasses", null),
      },
    };
  },
});
