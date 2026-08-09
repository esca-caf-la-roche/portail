/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function ajouterSnapshot(t: ReturnType<typeof convexTest>, licence: string) {
  return await t.run(async (ctx) => await ctx.db.insert("abo_abonnes_scrap", {
    licence,
    nom: "DUPONT",
    prenom: licence,
    nom_prenom_normalise: `DUPONT ${licence}`,
    abonnement_valide: "oui",
  }));
}

describe("snapshot des abonnés du site club", () => {
  test("retire du cache les abonnés absents d'un scrape complet", async () => {
    const t = convexTest(schema, modules);
    const conserve = await ajouterSnapshot(t, "123456789012");
    const retire = await ajouterSnapshot(t, "987654321098");

    await expect(t.mutation(internal.abo.matching.supprimerAbonnesScrapAbsents, {
      licences: ["123456789012"],
    })).resolves.toBe(1);

    expect(await t.run(async (ctx) => await ctx.db.get(conserve))).not.toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.get(retire))).toBeNull();
  });

  test("refuse une purge quand le scrape ne fournit aucune licence", async () => {
    const t = convexTest(schema, modules);
    const existant = await ajouterSnapshot(t, "123456789012");

    await expect(t.mutation(internal.abo.matching.supprimerAbonnesScrapAbsents, {
      licences: [],
    })).rejects.toThrow("Refus de purger");

    expect(await t.run(async (ctx) => await ctx.db.get(existant))).not.toBeNull();
  });

  test("retire les confirmations du site sans supprimer la demande portail", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "candidat@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "candidat@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-08-09T00:00:00.000Z",
      });
      return await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "DUPONT", prenom: "Camille", nom_prenom_normalise: "DUPONT CAMILLE",
        licence: "123456789012", licence_statut: "saisie", age: 32,
        etape_demande: true, etape_validation: "validee", etape_licence: true,
        etape_test_autonomie: "valide", etape_inscription_site: true, etape_photo: true,
        etape_paiement: false, etape_abonnement_valide: true,
      });
    });
    await ajouterSnapshot(t, "123456789012");

    await t.mutation(internal.abo.matching.supprimerAbonnesScrapAbsents, { licences: ["987654321098"] });
    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    expect(await t.run(async (ctx) => await ctx.db.get(personneId))).toMatchObject({
      etape_demande: true, etape_validation: "validee", etape_licence: false,
      etape_inscription_site: false, etape_photo: false, etape_abonnement_valide: false,
    });
  });
});
