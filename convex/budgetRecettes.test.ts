/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function creerStaffBudget(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: `budget-${crypto.randomUUID()}@test.fr` });
    await ctx.db.insert("userSettings", { userId: id, allowedTiles: ["budget"], role: "user" });
    return id;
  });
  return t.withIdentity({ subject: userId });
}

async function insererParametresPaie(
  t: ReturnType<typeof convexTest>,
  saison = "2026-27",
) {
  await t.run((ctx) =>
    ctx.db.insert("parametresPaie", {
      saison,
      margeSecurite: 1,
      indemniteCpPct: 10,
      mutuelleSalarie: 0,
      mutuelleEmployeur: 0,
      primeEquipementAnnuelle: 0,
      fraisBulletin: 0,
      cotisationsSalariales: [],
      cotisationsPatronales: [],
    }),
  );
}

describe("répartition des recettes du budget", () => {
  test("protège la lecture par la tuile budget", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "sans-budget@test.fr" }));
    const sansAcces = t.withIdentity({ subject: userId });

    await expect(
      sansAcces.query(api.budgetRecettes.getRepartition, { saison: "2026-27" }),
    ).rejects.toThrow("Accès refusé");
  });

  test("utilise strictement ESC01 et ESC02, les capacités cumulées et toutes les heures", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await insererParametresPaie(t);

    await t.run(async (ctx) => {
      const esc01 = await ctx.db.insert("analytiques", { nom: "ESC01 : Cours mineurs" });
      const esc02 = await ctx.db.insert("analytiques", { nom: "ESC02 : Cours adultes" });
      const presqueEsc01 = await ctx.db.insert("analytiques", { nom: "XESC01" });
      const autres = await ctx.db.insert("analytiques", { nom: "AUTRE" });
      const salarieId = await ctx.db.insert("salaries", { nom: "Monitrice", typeContrat: "CDII" });
      await ctx.db.insert("salairesSaison", {
        salarieId,
        saison: "2026-27",
        nbHeuresAnnuel: 999,
        nbMois: 12,
        tauxHoraireBrut: 20,
        heuresSup: [{ designation: "Stage", nbHeures: 5 }],
      });

      const cours = [
        { nom: "Mineurs A", analytiqueId: esc01, tarif: 100, capacite: 10, duree: 1 },
        { nom: "Mineurs B", analytiqueId: esc01, tarif: 150, capacite: 6, duree: 1 },
        { nom: "Adultes", analytiqueId: esc02, tarif: 200, capacite: 5, duree: 2 },
        { nom: "Hors périmètre", analytiqueId: presqueEsc01, tarif: 50, capacite: 2, duree: 1 },
      ];
      for (const [ordre, c] of cours.entries()) {
        await ctx.db.insert("cours", {
          saison: "2026-27",
          nom: c.nom,
          tarifAnnuel: c.tarif,
          nbElevesMax: c.capacite,
          analytiqueId: c.analytiqueId,
          moniteurs: [{ salarieId, nbSemaines: 10 }],
          seances: [{ jour: ordre, heureDebut: "18:00", dureeHeures: c.duree }],
        });
      }
      await ctx.db.insert("previsionnels", {
        nom: "Cours", montant: 100, etat: false, analytiqueId: esc01, saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Autres", montant: 200, etat: false, analytiqueId: autres, saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Dépense", montant: -500, etat: false, analytiqueId: esc01, saison: "2026-27",
      });
      await ctx.db.insert("previsionnels", {
        nom: "Autre saison", montant: 9999, etat: false, analytiqueId: esc01, saison: "2025-26",
      });
    });

    const resultat = await staff.query(api.budgetRecettes.getRepartition, { saison: "2026-27" });

    expect(resultat.totalRecettes).toBe(300);
    expect(resultat.recettes.map((r) => [r.analytiqueNom, r.montant])).toEqual([
      ["AUTRE", 200],
      ["ESC01 : Cours mineurs", 100],
    ]);
    expect(resultat.cours.mineurs).toMatchObject({
      recette: 1900,
      nbParticipants: 16,
      nbCreneaux: 2,
      heures: 25,
      coutSalarial: 642.05,
      resultat: 1257.95,
      resultatParParticipant: 78.62,
    });
    expect(resultat.cours.adultes).toMatchObject({
      recette: 1000,
      nbParticipants: 5,
      nbCreneaux: 1,
      heures: 25,
      coutSalarial: 642.05,
      resultat: 357.95,
      resultatParParticipant: 71.59,
    });
  });

  test("ne mélange pas les saisons", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await t.run(async (ctx) => {
      const esc01 = await ctx.db.insert("analytiques", { nom: "ESC01" });
      const salarieId = await ctx.db.insert("salaries", { nom: "Moniteur", typeContrat: "CDII" });
      await ctx.db.insert("cours", {
        saison: "2025-26", nom: "Ancien", tarifAnnuel: 500, nbElevesMax: 99,
        analytiqueId: esc01, moniteurs: [{ salarieId, nbSemaines: 30 }],
        seances: [{ jour: 1, heureDebut: "18:00", dureeHeures: 1 }],
      });
    });

    const resultat = await staff.query(api.budgetRecettes.getRepartition, { saison: "2026-27" });
    expect(resultat.cours.mineurs).toMatchObject({ recette: 0, nbParticipants: 0, nbCreneaux: 0 });
  });

  test("rend les coûts indisponibles si la paie d'un moniteur ESC02 manque", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await insererParametresPaie(t);
    await t.run(async (ctx) => {
      const esc02 = await ctx.db.insert("analytiques", { nom: "ESC02" });
      const moniteurSansPaie = await ctx.db.insert("salaries", { nom: "Sans paie", typeContrat: "CDII" });
      await ctx.db.insert("cours", {
        saison: "2026-27", nom: "Adultes", tarifAnnuel: 200, nbElevesMax: 10,
        analytiqueId: esc02, moniteurs: [{ salarieId: moniteurSansPaie, nbSemaines: 30 }],
        seances: [{ jour: 1, heureDebut: "19:00", dureeHeures: 1.5 }],
      });
    });

    const resultat = await staff.query(api.budgetRecettes.getRepartition, { saison: "2026-27" });
    expect(resultat.cours.adultes).toMatchObject({
      recette: 2000,
      nbParticipants: 10,
      coutSalarial: null,
      resultat: null,
      resultatParParticipant: null,
    });
  });
});

describe("déclaration des écoles", () => {
  test("protège la lecture par la tuile budget", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "sans-budget-decl@test.fr" }));
    const sansAcces = t.withIdentity({ subject: userId });

    await expect(
      sansAcces.query(api.budgetRecettes.getDeclarationEcoles, { saison: "2026-27" }),
    ).rejects.toThrow("Accès refusé");
  });

  test("agrège par catégorie de cours en cohérence avec la répartition des recettes", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await insererParametresPaie(t);

    await t.run(async (ctx) => {
      const esc01 = await ctx.db.insert("analytiques", { nom: "ESC01 : Cours mineurs" });
      const esc02 = await ctx.db.insert("analytiques", { nom: "ESC02 : Cours adultes" });
      const moniteurA = await ctx.db.insert("salaries", { nom: "Alice", typeContrat: "CDII" });
      const moniteurB = await ctx.db.insert("salaries", { nom: "Bob", typeContrat: "CDII" });

      for (const salarieId of [moniteurA, moniteurB]) {
        await ctx.db.insert("salairesSaison", {
          salarieId,
          saison: "2026-27",
          nbHeuresAnnuel: 0,
          nbMois: 12,
          tauxHoraireBrut: 20,
        });
      }

      // 2 créneaux de "5/6 ans" (1 séance/semaine chacun, 2 moniteurs distincts au total)
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "5/6 ans",
        tarifAnnuel: 280,
        nbElevesMax: 8,
        analytiqueId: esc01,
        moniteurs: [{ salarieId: moniteurA, nbSemaines: 10 }],
        seances: [{ jour: 0, heureDebut: "17:30", dureeHeures: 1 }],
      });
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "5/6 ans",
        tarifAnnuel: 280,
        nbElevesMax: 10,
        analytiqueId: esc01,
        moniteurs: [{ salarieId: moniteurB, nbSemaines: 10 }],
        seances: [{ jour: 2, heureDebut: "14:00", dureeHeures: 1 }],
      });

      // 1 créneau compétition avec 2 séances/semaine
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "Groupe Perf",
        tarifAnnuel: 400,
        nbElevesMax: 14,
        competition: true,
        analytiqueId: esc01,
        moniteurs: [{ salarieId: moniteurA, nbSemaines: 10 }],
        seances: [
          { jour: 1, heureDebut: "18:00", dureeHeures: 1 },
          { jour: 3, heureDebut: "18:00", dureeHeures: 1 },
        ],
      });

      // 1 créneau adultes (ESC02)
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "Adultes Débutants",
        tarifAnnuel: 300,
        nbElevesMax: 12,
        analytiqueId: esc02,
        moniteurs: [{ salarieId: moniteurB, nbSemaines: 10 }],
        seances: [{ jour: 4, heureDebut: "19:00", dureeHeures: 1 }],
      });
    });

    const [decl, repartition] = await Promise.all([
      staff.query(api.budgetRecettes.getDeclarationEcoles, { saison: "2026-27" }),
      staff.query(api.budgetRecettes.getRepartition, { saison: "2026-27" }),
    ]);

    expect(decl.hasParametresPaie).toBe(true);
    expect(decl.moniteursSansPaie).toEqual([]);
    expect(decl.categories.map((c) => c.nom)).toEqual([
      "5/6 ans",
      "Adultes Débutants",
      "Groupe Perf",
    ]);

    const cinqSix = decl.categories.find((c) => c.nom === "5/6 ans")!;
    expect(cinqSix).toMatchObject({
      estAdulte: false,
      competition: false,
      nbCreneaux: 2,
      nbCoursParSemaine: 1,
      nbJeunes: 18,
      totalJeunesSeances: 18,
      nbEncadrants: 2,
      moniteursNoms: ["Alice", "Bob"],
      recette: 5040,
    });

    const perf = decl.categories.find((c) => c.nom === "Groupe Perf")!;
    expect(perf).toMatchObject({
      estAdulte: false,
      competition: true,
      nbCreneaux: 1,
      nbCoursParSemaine: 2,
      nbJeunes: 14,
      totalJeunesSeances: 28,
      nbEncadrants: 1,
      recette: 5600,
    });

    const adultes = decl.categories.find((c) => c.nom === "Adultes Débutants")!;
    expect(adultes.estAdulte).toBe(true);
    expect(adultes.recette).toBe(3600);

    // Cohérence totale avec getRepartition pour ESC01 (mineurs)
    const sommeRecettesMineurs = decl.categories
      .filter((c) => !c.estAdulte)
      .reduce((acc, c) => acc + c.recette, 0);
    const sommeCoutsMineurs = decl.categories
      .filter((c) => !c.estAdulte)
      .reduce((acc, c) => acc + (c.coutSalarial ?? 0), 0);
    expect(sommeRecettesMineurs).toBe(repartition.cours.mineurs.recette);
    expect(Math.round(sommeCoutsMineurs * 100) / 100).toBe(repartition.cours.mineurs.coutSalarial);
  });

  test("signale un moniteur sans paie sans masquer les recettes", async () => {
    const t = convexTest(schema, modules);
    const staff = await creerStaffBudget(t);
    await insererParametresPaie(t);

    await t.run(async (ctx) => {
      const esc01 = await ctx.db.insert("analytiques", { nom: "ESC01" });
      const sansPaie = await ctx.db.insert("salaries", { nom: "Sans paie", typeContrat: "CDII" });
      await ctx.db.insert("cours", {
        saison: "2026-27",
        nom: "Lycéens",
        tarifAnnuel: 350,
        nbElevesMax: 10,
        analytiqueId: esc01,
        moniteurs: [{ salarieId: sansPaie, nbSemaines: 30 }],
        seances: [{ jour: 0, heureDebut: "18:00", dureeHeures: 1.5 }],
      });
    });

    const decl = await staff.query(api.budgetRecettes.getDeclarationEcoles, { saison: "2026-27" });
    expect(decl.moniteursSansPaie).toEqual(["Sans paie"]);
    expect(decl.categories[0]).toMatchObject({
      nom: "Lycéens",
      recette: 3500,
      coutSalarial: null,
      resultat: null,
    });
  });
});
