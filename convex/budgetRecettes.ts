import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
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
      const params = toParametresPaie(parametres);
      for (const salaire of salaires) {
        const ventilation = heuresParSalarie.get(salaire.salarieId) ?? zeroVentilation();
        const heuresCoursSalarie = categories.reduce((total, cible) => total + ventilation[cible], 0);
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
        for (const cible of categories) {
          couts[cible] += paie.coutAnnuel * (ventilation[cible] / heuresCoursSalarie);
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
