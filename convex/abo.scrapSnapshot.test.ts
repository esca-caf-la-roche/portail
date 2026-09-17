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
  test("attribue une licence par identité seulement quand le rapprochement est unique", async () => {
    const t = convexTest(schema, modules);
    const { personneId, reservationId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "gestion-famille@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "gestion-famille@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "Guigo", prenom: "Olivia", nom_prenom_normalise: "GUIGO OLIVIA",
        licence_statut: "inconnu", etape_demande: true, etape_validation: "validee",
        etape_licence: false, etape_inscription_site: false, etape_photo: false,
        etape_paiement: false, etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "OLIVIA",
        nom_prenom_normalise: "GUIGO OLIVIA", age: 18, autonomie: "Non autonome",
        adhesion: "OK", abonnement_valide: "oui",
      });
      const reservationId = await ctx.db.insert("abo_test_reservations", {
        personne_id: personneId,
        tranche: "2099-09-16T10:00:00.000Z",
        statut: "active",
        etat_confirmation: "provisoire",
      });
      return { personneId, reservationId };
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    expect(await t.run((ctx) => ctx.db.get(personneId))).toMatchObject({
      nom: "Guigo",
      prenom: "Olivia",
      nom_prenom_normalise: "GUIGO OLIVIA",
      licence: "748020279190",
      licence_statut: "annuaire_auto",
      etape_test_autonomie: "requis",
    });
    expect(await t.run((ctx) => ctx.db.get(reservationId))).toMatchObject({
      statut: "active",
      etat_confirmation: "provisoire",
    });
  });

  test("traite « Non précisée » comme un test requis", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "non-precisee@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "non-precisee@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
      });
      const id = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "Dupont", prenom: "Camille", nom_prenom_normalise: "DUPONT CAMILLE",
        licence: "748020279191", licence_statut: "saisie", etape_demande: true,
        etape_validation: "validee", etape_licence: false, etape_inscription_site: false,
        etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279191", nom: "DUPONT", prenom: "CAMILLE",
        nom_prenom_normalise: "DUPONT CAMILLE", autonomie: "Non précisée",
        abonnement_valide: "oui",
      });
      return id;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    expect(await t.run((ctx) => ctx.db.get(personneId))).toMatchObject({
      etape_test_autonomie: "requis",
    });
  });

  test("n'attribue aucune licence quand plusieurs personnes portent la même identité", async () => {
    const t = convexTest(schema, modules);
    const personneIds = await t.run(async (ctx) => {
      const ids = [];
      for (const suffixe of ["a", "b"]) {
        const ownerId = await ctx.db.insert("users", { email: `${suffixe}@example.test` });
        const dossierId = await ctx.db.insert("abo_dossiers", {
          email: `${suffixe}@example.test`, owner_id: ownerId,
          statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
        });
        ids.push(await ctx.db.insert("abo_personnes", {
          dossier_id: dossierId, nom: "DUPONT", prenom: "Camille",
          nom_prenom_normalise: "DUPONT CAMILLE", licence_statut: "inconnu",
          etape_demande: true, etape_validation: "validee", etape_licence: false,
          etape_inscription_site: false, etape_photo: false, etape_paiement: false,
          etape_abonnement_valide: false,
        }));
      }
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "123456789012", nom: "DUPONT", prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE", abonnement_valide: "oui",
      });
      return ids;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    const personnes = await t.run(async (ctx) => Promise.all(
      personneIds.map((personneId) => ctx.db.get(personneId)),
    ));
    expect(personnes.every((personne) => personne?.licence === undefined)).toBe(true);
  });

  test("n'attribue pas une licence déjà portée par une autre personne", async () => {
    const t = convexTest(schema, modules);
    const candidateId = await t.run(async (ctx) => {
      const ownerPorteur = await ctx.db.insert("users", { email: "porteur@example.test" });
      const dossierPorteur = await ctx.db.insert("abo_dossiers", {
        email: "porteur@example.test", owner_id: ownerPorteur,
        statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
      });
      await ctx.db.insert("abo_personnes", {
        dossier_id: dossierPorteur, nom: "MARTIN", prenom: "Alex",
        nom_prenom_normalise: "MARTIN ALEX", licence: "748020279190", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      const ownerCandidate = await ctx.db.insert("users", { email: "famille@example.test" });
      const dossierCandidate = await ctx.db.insert("abo_dossiers", {
        email: "famille@example.test", owner_id: ownerCandidate,
        statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
      });
      const candidateId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierCandidate, nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", licence_statut: "inconnu",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", abonnement_valide: "oui",
      });
      return candidateId;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    expect((await t.run((ctx) => ctx.db.get(candidateId)))?.licence).toBeUndefined();
  });

  test("ne corrige jamais automatiquement une licence existante", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "olivia@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "olivia@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-16T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", licence: "748020279182", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: true,
        etape_inscription_site: true, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", abonnement_valide: "oui",
      });
      return personneId;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});

    expect(await t.run((ctx) => ctx.db.get(personneId))).toMatchObject({
      nom: "GUIGO",
      prenom: "Olivia",
      nom_prenom_normalise: "GUIGO OLIVIA",
      licence: "748020279182",
      licence_statut: "saisie",
    });
  });

  test("pilote l'étape paiement depuis la colonne Paiement du site club", async () => {
    const t = convexTest(schema, modules);
    const { personneId, scrapId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "paiement@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "paiement@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-11T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "DUPONT", prenom: "Camille", nom_prenom_normalise: "DUPONT CAMILLE",
        licence: "123456789012", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      const scrapId = await ctx.db.insert("abo_abonnes_scrap", {
        licence: "123456789012", nom: "DUPONT", prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE", paiement: "OK",
        abonnement_valide: "non",
      });
      return { personneId, scrapId };
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect(await t.run(async (ctx) => (await ctx.db.get(personneId))?.etape_paiement)).toBe(true);

    await t.run(async (ctx) => await ctx.db.patch(scrapId, { paiement: "" }));
    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect(await t.run(async (ctx) => (await ctx.db.get(personneId))?.etape_paiement)).toBe(false);
  });

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
