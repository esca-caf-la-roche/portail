/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function jourParis(): string {
  const parties = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const valeurs = Object.fromEntries(
    parties.filter((partie) => partie.type !== "literal")
      .map((partie) => [partie.type, partie.value]),
  );
  return `${valeurs.year}-${valeurs.month}-${valeurs.day}`;
}

async function creerAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "projection@example.test" });
    await ctx.db.insert("userSettings", {
      userId: id,
      allowedTiles: ["abonnements", "licences_cours"],
      role: "admin",
    });
    return id;
  });
  return t.withIdentity({ subject: userId });
}

const lignes = [
  {
    licence: "123456789012",
    nom: "DUPONT",
    prenom: "Camille",
    horaire: "Lundi 18h",
    cours: "Adultes",
    age: "31",
    encadrants: "Alice, Bob",
    paiement_recu: "Oui",
    paiements_dossier: "CB 180 EUR",
    email_eleve: "camille@example.test",
  },
  {
    nom: "MARTIN",
    prenom: "Jeanne",
    horaire: "Mardi 19h",
    cours: "Adultes",
    saison_precedente: "",
    email_gestion: "famille@example.test",
  },
];

describe("projection compacte des élèves en cours", () => {
  test("le backfill conserve le fallback jusqu'à sa dernière page puis garantit la parité", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      for (const ligne of lignes) {
        await ctx.db.insert("abo_eleves_en_cours", {
          ...ligne,
          nom_prenom_normalise: `${ligne.nom} ${ligne.prenom}`,
          imported_at: "2026-09-01T00:00:00.000Z",
        });
      }
    });

    const avant = await admin.query(api.abo.compteur.getElevesEnCours, {});
    const licencesAvant = await admin.query(
      api.abo.licencesEnCours.getElevesLicenceInvalide,
      { maintenantJour: jourParis() },
    );
    const premiere = await t.mutation(
      internal.abo.compteur.backfillProjectionElevesEnCours,
      { paginationOpts: { cursor: null, numItems: 1 } },
    );
    expect(premiere.isDone).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", "projection_eleves_en_cours_complete"))
      .first())).toBeNull();
    expect(await admin.query(api.abo.compteur.getElevesEnCours, {})).toEqual(avant);

    const derniere = await t.mutation(
      internal.abo.compteur.backfillProjectionElevesEnCours,
      { paginationOpts: { cursor: premiere.continueCursor, numItems: 10 } },
    );
    expect(derniere.isDone).toBe(true);
    expect(await admin.query(api.abo.compteur.getElevesEnCours, {})).toEqual(avant);
    expect(await admin.query(
      api.abo.licencesEnCours.getElevesLicenceInvalide,
      { maintenantJour: jourParis() },
    )).toEqual(licencesAvant);

    const projections = await t.run(async (ctx) =>
      ctx.db.query("abo_eleves_en_cours_lecture").collect()
    );
    expect(projections).toHaveLength(2);
    expect(projections[0]).not.toHaveProperty("paiements_dossier");
    expect(projections[0]).not.toHaveProperty("encadrants");
  });

  test("le remplacement maintient insertions, modifications et suppressions atomiquement", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, {
      saison: "2026 / 2027",
      lignes,
    });
    let etat = await t.run(async (ctx) => ({
      sources: await ctx.db.query("abo_eleves_en_cours").collect(),
      projections: await ctx.db.query("abo_eleves_en_cours_lecture").collect(),
    }));
    expect(etat.projections).toHaveLength(etat.sources.length);
    expect(new Set(etat.projections.map((row) => row.source_eleve_id)))
      .toEqual(new Set(etat.sources.map((row) => row._id)));

    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, {
      saison: "2026 / 2027",
      lignes: [{ ...lignes[0], horaire: "Jeudi 20h" }],
    });
    etat = await t.run(async (ctx) => ({
      sources: await ctx.db.query("abo_eleves_en_cours").collect(),
      projections: await ctx.db.query("abo_eleves_en_cours_lecture").collect(),
    }));
    expect(etat.sources).toHaveLength(1);
    expect(etat.projections).toHaveLength(1);
    expect(etat.projections[0]).toMatchObject({
      source_eleve_id: etat.sources[0]._id,
      horaire: "Jeudi 20h",
    });
  });

  test("une projection incomplète interdit la bascule", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const orphelineId = await ctx.db.insert("abo_eleves_en_cours", {
        nom_prenom_normalise: "ORPHELINE",
        imported_at: "2026-09-01T00:00:00.000Z",
      });
      await ctx.db.insert("abo_eleves_en_cours_lecture", {
        source_eleve_id: orphelineId,
        nom_prenom_normalise: "ORPHELINE",
      });
      await ctx.db.delete(orphelineId);
      await ctx.db.insert("abo_eleves_en_cours", {
        nom: "DUPONT",
        prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE",
        imported_at: "2026-09-01T00:00:00.000Z",
      });
    });
    await expect(t.mutation(
      internal.abo.compteur.backfillProjectionElevesEnCours,
      { paginationOpts: { cursor: null, numItems: 10 } },
    )).rejects.toThrow("projection compacte des élèves est incomplète");
  });

  test("deux remplacements avant exécution ne programment qu'un recalcul", async () => {
    const t = convexTest(schema, modules);
    const args = { saison: "2026 / 2027", lignes: [lignes[0]] };
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, args);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, args);
    const planifies = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(planifies).toHaveLength(1);
  });
});
