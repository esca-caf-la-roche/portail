/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function ajouterLicence(t: ReturnType<typeof convexTest>, licence: string) {
  return await t.run(async (ctx) => await ctx.db.insert("abo_licences", {
    licence, nom: "DUPONT", prenom: licence,
    nom_prenom_normalise: `DUPONT ${licence}`,
    imported_at: "2026-08-09T00:00:00.000Z",
  }));
}

describe("snapshot de l'annuaire des licences", () => {
  test("retire du cache les licences absentes du nouvel annuaire", async () => {
    const t = convexTest(schema, modules);
    const conserve = await ajouterLicence(t, "123456789012");
    const retire = await ajouterLicence(t, "987654321098");

    await expect(t.mutation(internal.abo.licences.supprimerLicencesAbsentes, {
      licences: ["123456789012"],
    })).resolves.toBe(1);
    expect(await t.run(async (ctx) => await ctx.db.get(conserve))).not.toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.get(retire))).toBeNull();
  });

  test("refuse une purge sans licence exploitable", async () => {
    const t = convexTest(schema, modules);
    const existante = await ajouterLicence(t, "123456789012");

    await expect(t.mutation(internal.abo.licences.supprimerLicencesAbsentes, {
      licences: [],
    })).rejects.toThrow("Refus de purger");
    expect(await t.run(async (ctx) => await ctx.db.get(existante))).not.toBeNull();
  });

});
