/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function creerAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "tests-admin@example.test" });
    await ctx.db.insert("userSettings", {
      userId: id,
      allowedTiles: ["abonnements"],
      role: "user",
    });
    return id;
  });
  return { userId, admin: t.withIdentity({ subject: userId }) };
}

async function ajouterLicence(
  t: ReturnType<typeof convexTest>,
  licence = "123456789012",
): Promise<Id<"abo_licences">> {
  return await t.run((ctx) =>
    ctx.db.insert("abo_licences", {
      licence,
      nom: "DUPONT",
      prenom: "Claire",
      nom_prenom_normalise: "dupont claire",
      imported_at: "2026-08-08T00:00:00.000Z",
    }),
  );
}

describe("archive des tests d'autonomie", () => {
  test("un admin Abonnements prépare un dépôt sans exposer le brouillon dans la file", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await ajouterLicence(t);

    const depot = await admin.mutation(api.abo.testDocuments.preparerDepot, {
      licence: "123456789012",
    });

    expect(depot).toMatchObject({ licence: "123456789012", nom: "DUPONT", prenom: "Claire" });
    expect(depot.uploadToken).not.toHaveLength(0);
    await expect(admin.query(api.abo.testDocuments.listArchives, { filtre: "a_traiter" }))
      .resolves.toEqual([]);
  });

  test("refuse un second fichier lorsqu'une archive Drive existe déjà", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await ajouterLicence(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_tests_autonomie_archive", {
        licence: "123456789012",
        nom: "DUPONT",
        prenom: "Claire",
        nom_prenom_normalise: "dupont claire",
        drive_file_id: "drive-file",
        drive_url: "https://drive.example.test/file",
        statut: "traite",
      });
    });

    await expect(admin.mutation(api.abo.testDocuments.preparerDepot, {
      licence: "123456789012",
    })).rejects.toThrow("ne peut pas être remplacé");
  });

  test("refuse la préparation à un compte sans tuile Abonnements", async () => {
    const t = convexTest(schema, modules);
    await ajouterLicence(t);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "sans-tuile@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: id,
        email: "sans-tuile@example.test",
        role: "utilisateur",
      });
      return id;
    });
    const caller = t.withIdentity({ subject: userId });

    await expect(caller.mutation(api.abo.testDocuments.preparerDepot, {
      licence: "123456789012",
    })).rejects.toThrow("Réservé aux administrateurs");
  });
});
