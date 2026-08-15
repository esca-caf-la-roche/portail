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
    parties.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  return `${valeurs.year}-${valeurs.month}-${valeurs.day}`;
}

async function creerStaff(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "licences-cours@example.test" });
    await ctx.db.insert("userSettings", {
      userId: id,
      allowedTiles: ["licences_cours"],
      role: "user",
    });
    return id;
  });
  return { userId, staff: t.withIdentity({ subject: userId }) };
}

async function ajouterEleve(
  t: ReturnType<typeof convexTest>,
  suffixe: string,
  options: { licence?: string; dateNaissance?: string; email?: string } = {},
) {
  return await t.run(async (ctx) => await ctx.db.insert("abo_eleves_en_cours", {
    licence: options.licence,
    nom: "DUPONT",
    prenom: suffixe,
    nom_prenom_normalise: `DUPONT ${suffixe}`,
    date_naissance: options.dateNaissance,
    email_eleve: options.email,
    cours: "Escalade",
    horaire: "Lundi 18h",
    saison: "2026 / 2027",
    imported_at: "2026-08-15T00:00:00.000Z",
  }));
}

describe("suivi des licences des élèves en cours", () => {
  test("le marquage est idempotent et protégé par la tuile", async () => {
    const t = convexTest(schema, modules);
    const { staff } = await creerStaff(t);
    const [sansTuile, sansSettings] = await t.run(async (ctx) => {
      const premier = await ctx.db.insert("users", { email: "sans-tuile@example.test" });
      await ctx.db.insert("userSettings", {
        userId: premier,
        allowedTiles: [],
        role: "user",
      });
      const second = await ctx.db.insert("users", { email: "abo-public@example.test" });
      return [premier, second] as const;
    });
    const eleveId = await ajouterEleve(t, "ALICE", {
      dateNaissance: "2012-04-03",
    });

    await expect(t.withIdentity({ subject: sansTuile }).mutation(
      api.abo.licencesEnCours.definirTraite,
      { eleveId, traite: true },
    )).rejects.toThrow("Accès refusé");
    await expect(t.withIdentity({ subject: sansSettings }).mutation(
      api.abo.licencesEnCours.definirTraite,
      { eleveId, traite: true },
    )).rejects.toThrow("Accès refusé");

    const premier = await staff.mutation(api.abo.licencesEnCours.definirTraite, {
      eleveId,
      traite: true,
    });
    const second = await staff.mutation(api.abo.licencesEnCours.definirTraite, {
      eleveId,
      traite: true,
    });
    expect(second).toEqual(premier);
    expect(await t.run(async (ctx) =>
      ctx.db.query("abo_licences_cours_traitements").collect(),
    )).toHaveLength(1);
  });

  test("refuse un nom seul ambigu", async () => {
    const t = convexTest(schema, modules);
    const { staff } = await creerStaff(t);
    const eleveId = await ajouterEleve(t, "ROBIN");
    await ajouterEleve(t, "ROBIN");

    await expect(staff.mutation(api.abo.licencesEnCours.definirTraite, {
      eleveId,
      traite: true,
    })).rejects.toThrow("homonymie");
  });

  test("une licence synchronisée prime et purge le traitement", async () => {
    const t = convexTest(schema, modules);
    const { staff } = await creerStaff(t);
    const eleveId = await ajouterEleve(t, "LINA", {
      dateNaissance: "2013-05-07",
    });
    await staff.mutation(api.abo.licencesEnCours.definirTraite, {
      eleveId,
      traite: true,
    });

    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, {
      saison: "2026 / 2027",
      lignes: [{
        licence: "123456789012",
        nom: "DUPONT",
        prenom: "LINA",
        date_naissance: "2013-05-07",
        cours: "Escalade",
        horaire: "Lundi 18h",
      }],
    });

    expect(await t.run(async (ctx) =>
      ctx.db.query("abo_licences_cours_traitements").collect(),
    )).toEqual([]);
    expect(await staff.query(api.abo.licencesEnCours.getElevesLicenceInvalide, {
      maintenantJour: jourParis(),
    })).toEqual({ total: 0, eleves: [] });
  });
});
