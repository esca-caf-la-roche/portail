/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("suivi du dossier abonné", () => {
  test("confirme le point 5 depuis la colonne Paiement du site club", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, scrapId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "suivi@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: ownerId,
        email: "suivi@example.test",
        role: "utilisateur",
      });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "suivi@example.test",
        owner_id: ownerId,
        statut_dossier: "validee",
        date_soumission: "2026-09-16T00:00:00.000Z",
      });
      await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId,
        nom: "DUPONT",
        prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE",
        licence: "123456789012",
        licence_statut: "saisie",
        etape_demande: true,
        etape_validation: "validee",
        etape_licence: false,
        etape_inscription_site: true,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
      });
      const scrapId = await ctx.db.insert("abo_abonnes_scrap", {
        licence: "123456789012",
        nom: "DUPONT",
        prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE",
        paiement: "OK",
        abonnement_valide: "non",
      });
      return { ownerId, scrapId };
    });

    const abonne = t.withIdentity({ subject: ownerId });
    await expect(abonne.query(api.abo.demandes.monSuivi, {})).resolves.toMatchObject([
      { paiement_ok: true },
    ]);

    await t.run((ctx) => ctx.db.patch(scrapId, {
      paiement: "",
      abonnement_valide: "oui",
    }));
    await expect(abonne.query(api.abo.demandes.monSuivi, {})).resolves.toMatchObject([
      { paiement_ok: false },
    ]);
  });
});
