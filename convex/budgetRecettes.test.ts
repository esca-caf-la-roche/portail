/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function creerStaffBudget(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: `budget-${crypto.randomUUID()}@test.fr` });
    await ctx.db.insert("userSettings", {
      userId: id,
      allowedTiles: ["budget"],
      role: "user",
    });
    return id;
  });
  return t.withIdentity({ subject: userId });
}

describe("répartition des recettes du budget", () => {
  test("protège la lecture et l'écriture par la tuile budget", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "sans-budget@test.fr" }));
    const sansAcces = t.withIdentity({ subject: userId });

    await expect(
      sansAcces.query(api.budgetRecettes.getRepartition, { saison: "2026-27" }),
    ).rejects.toThrow("Accès refusé");
    await expect(
      sansAcces.mutation(api.effectifs.setEffectifsCours, {
        saison: "2026-27",
        nbMineursCours: 10,
        nbAdultesCours: 5,
      }),
    ).rejects.toThrow("Accès refusé");
  });

  test("agrège les recettes et ventile le coût complet par public et par saison", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);

    await t.run(async (ctx) => {
      const anaCours = await ctx.db.insert("analytiques", { nom: "Cours" });
      const anaAutres = await ctx.db.insert("analytiques", { nom: "Autres recettes" });
      const salarieId = await ctx.db.insert("salaries", {
        nom: "Monitrice",
        typeContrat: "CDII",
      });
      await ctx.db.insert("salairesSaison", {
        salarieId,
        saison: "2026-27",
        nbHeuresAnnuel: 999,
        nbMois: 12,
        tauxHoraireBrut: 20,
        heuresSup: [{ designation: "Stage", nbHeures: 5 }],
      });
      await ctx.db.insert("parametresPaie", {
        saison: "2026-27",
        margeSecurite: 1,
        indemniteCpPct: 10,
        mutuelleSalarie: 0,
        mutuelleEmployeur: 0,
        primeEquipementAnnuelle: 0,
        fraisBulletin: 0,
        cotisationsSalariales: [],
        cotisationsPatronales: [],
      });
      const cours = [
        { publicCible: "mineurs" as const, tarifAnnuel: 100, nbElevesMax: 10, duree: 1 },
        { publicCible: "adultes" as const, tarifAnnuel: 200, nbElevesMax: 5, duree: 2 },
        { publicCible: undefined, tarifAnnuel: 50, nbElevesMax: 2, duree: 1 },
      ];
      for (const [ordre, c] of cours.entries()) {
        await ctx.db.insert("cours", {
          saison: "2026-27",
          nom: `Cours ${ordre}`,
          tarifAnnuel: c.tarifAnnuel,
          nbElevesMax: c.nbElevesMax,
          publicCible: c.publicCible,
          moniteurs: [{ salarieId, nbSemaines: 10 }],
          seances: [{ jour: ordre, heureDebut: "18:00", dureeHeures: c.duree }],
        });
      }
      await ctx.db.insert("previsionnels", {
        nom: "Cours mineurs",
        montant: 100,
        etat: false,
        analytiqueId: anaCours,
        saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Autres",
        montant: 200,
        etat: false,
        analytiqueId: anaAutres,
        saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Dépense exclue",
        montant: -500,
        etat: false,
        analytiqueId: anaCours,
        saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Autre saison exclue",
        montant: 9999,
        etat: false,
        analytiqueId: anaCours,
        saison: "2025-26",
      });
    });

    await staff.mutation(api.effectifs.setEffectifsCours, {
      saison: "2026-27",
      nbMineursCours: 8.2,
      nbAdultesCours: 4,
    });
    const resultat = await staff.query(api.budgetRecettes.getRepartition, {
      saison: "2026-27",
    });

    expect(resultat.totalRecettes).toBe(300);
    expect(resultat.recettes.map((r) => [r.analytiqueNom, r.montant])).toEqual([
      ["Autres recettes", 200],
      ["Cours", 100],
    ]);
    expect(resultat.cours.mineurs).toMatchObject({
      recette: 1000,
      coutSalarial: 330,
      resultat: 670,
      nbParticipants: 8,
      resultatParParticipant: 83.75,
      nbCreneaux: 1,
      heures: 12.5,
    });
    expect(resultat.cours.adultes).toMatchObject({
      recette: 1000,
      coutSalarial: 660,
      resultat: 340,
      nbParticipants: 4,
      resultatParParticipant: 85,
      heures: 25,
    });
    expect(resultat.cours.nonClasses).toMatchObject({
      recette: 100,
      coutSalarial: 330,
      resultat: -230,
      nbParticipants: null,
      resultatParParticipant: null,
      nbCreneaux: 1,
      heures: 12.5,
    });
  });

  test("renvoie des coûts nuls si la paie manque et conserve les autres effectifs", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await t.run((ctx) =>
      ctx.db.insert("budgetEffectifs", {
        saison: "2026-27",
        nbMembresLoisir: 42,
      }),
    );

    await staff.mutation(api.effectifs.setEffectifsCours, {
      saison: "2026-27",
      nbMineursCours: 0,
      nbAdultesCours: 0,
    });
    const resultat = await staff.query(api.budgetRecettes.getRepartition, {
      saison: "2026-27",
    });
    const effectifs = await t.run((ctx) =>
      ctx.db
        .query("budgetEffectifs")
        .withIndex("by_saison", (q) => q.eq("saison", "2026-27"))
        .unique(),
    );

    expect(resultat.cours.mineurs).toMatchObject({
      coutSalarial: null,
      resultat: null,
      resultatParParticipant: null,
    });
    expect(effectifs).toMatchObject({
      nbMembresLoisir: 42,
      nbMineursCours: 0,
      nbAdultesCours: 0,
    });
  });

  test("ne présente pas un coût partiel si un moniteur du planning n'a pas de paie", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await t.run(async (ctx) => {
      const moniteurAvecPaie = await ctx.db.insert("salaries", {
        nom: "Avec paie",
        typeContrat: "CDII",
      });
      const moniteurSansPaie = await ctx.db.insert("salaries", {
        nom: "Sans paie",
        typeContrat: "CDII",
      });
      await ctx.db.insert("salairesSaison", {
        salarieId: moniteurAvecPaie,
        saison: "2026-27",
        nbHeuresAnnuel: 10,
        nbMois: 12,
        tauxHoraireBrut: 20,
      });
      await ctx.db.insert("parametresPaie", {
        saison: "2026-27",
        margeSecurite: 1,
        indemniteCpPct: 10,
        mutuelleSalarie: 0,
        mutuelleEmployeur: 0,
        primeEquipementAnnuelle: 0,
        fraisBulletin: 0,
        cotisationsSalariales: [],
        cotisationsPatronales: [],
      });
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "Adultes",
        tarifAnnuel: 200,
        nbElevesMax: 10,
        publicCible: "adultes",
        moniteurs: [{ salarieId: moniteurSansPaie, nbSemaines: 30 }],
        seances: [{ jour: 1, heureDebut: "19:00", dureeHeures: 1.5 }],
      });
    });

    const resultat = await staff.query(api.budgetRecettes.getRepartition, {
      saison: "2026-27",
    });
    expect(resultat.cours.adultes).toMatchObject({
      recette: 2000,
      coutSalarial: null,
      resultat: null,
      resultatParParticipant: null,
    });
  });

  test("classe tout un type historique lors de l'ajout d'un nouveau créneau", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    const salarieId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("salaries", { nom: "Moniteur", typeContrat: "CDII" });
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "Cours historique",
        tarifAnnuel: 100,
        nbElevesMax: 8,
        moniteurs: [{ salarieId: id, nbSemaines: 20 }],
        seances: [{ jour: 1, heureDebut: "18:00", dureeHeures: 1 }],
      });
      return id;
    });

    await staff.mutation(api.cours.addCours, {
      saison: "2026-27",
      nom: "Cours historique",
      tarifAnnuel: 100,
      nbElevesMax: 8,
      nbSemaines: 20,
      publicCible: "mineurs",
      moniteurs: [salarieId],
      seances: [{ jour: 3, heureDebut: "18:00", dureeHeures: 1 }],
    });

    const publics = await t.run(async (ctx) =>
      (await ctx.db
        .query("cours")
        .withIndex("by_saison", (q) => q.eq("saison", "2026-27"))
        .collect()).map((cours) => cours.publicCible),
    );
    expect(publics).toEqual(["mineurs", "mineurs"]);
  });
});
