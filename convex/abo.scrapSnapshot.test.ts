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
  test("corrige une ancienne licence par identité exacte unique et confirme la réservation", async () => {
    const t = convexTest(schema, modules);
    const { personneId, reservationId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "olivia@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "olivia@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-15T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "GUIGO", prenom: "Olivia", nom_prenom_normalise: "GUIGO OLIVIA",
        licence: "748020279182", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      const reservationId = await ctx.db.insert("abo_test_reservations", {
        personne_id: personneId,
        tranche: "2099-09-15T10:00:00.000Z",
        statut: "active",
        etat_confirmation: "provisoire",
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", age: 18,
        autonomie: "Doit passer le test", adhesion: "OK", abonnement_valide: "oui",
      });
      return { personneId, reservationId };
    });

    await expect(t.mutation(internal.abo.matching.matcherScrapPersonnes, {})).resolves.toBe(1);

    expect(await t.run((ctx) => ctx.db.get(personneId))).toMatchObject({
      nom: "GUIGO",
      prenom: "Olivia",
      nom_prenom_normalise: "GUIGO OLIVIA",
      licence: "748020279190",
      licence_statut: "annuaire_auto",
      etape_test_autonomie: "requis",
    });
    expect(await t.run((ctx) => ctx.db.get(reservationId))).toMatchObject({
      personne_id: personneId,
      statut: "active",
      etat_confirmation: "confirmee",
    });
    await expect(t.mutation(internal.abo.matching.matcherScrapPersonnes, {})).resolves.toBe(0);
  });

  test("ne corrige jamais automatiquement une licence validée manuellement", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "validee@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "validee@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-15T00:00:00.000Z",
      });
      const id = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "GUIGO", prenom: "Olivia", nom_prenom_normalise: "GUIGO OLIVIA",
        licence: "748020279182", licence_statut: "annuaire_valide",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", abonnement_valide: "oui",
      });
      return id;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect((await t.run((ctx) => ctx.db.get(personneId)))?.licence).toBe("748020279182");
  });

  test("ne corrige pas une licence quand le nom est ambigu", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "homonyme@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "homonyme@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-15T00:00:00.000Z",
      });
      const id = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "DUPONT", prenom: "Camille", nom_prenom_normalise: "DUPONT CAMILLE",
        licence: "111111111111", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      for (const licence of ["222222222222", "333333333333"]) {
        await ctx.db.insert("abo_abonnes_scrap", {
          licence, nom: "DUPONT", prenom: "Camille",
          nom_prenom_normalise: "DUPONT CAMILLE", abonnement_valide: "oui",
        });
      }
      return id;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect((await t.run((ctx) => ctx.db.get(personneId)))?.licence).toBe("111111111111");
  });

  test("ne corrige pas une licence quand l'identité existe dans plusieurs dossiers", async () => {
    const t = convexTest(schema, modules);
    const { cibleId } = await t.run(async (ctx) => {
      const creer = async (email: string, licence: string) => {
        const ownerId = await ctx.db.insert("users", { email });
        const dossierId = await ctx.db.insert("abo_dossiers", {
          email, owner_id: ownerId, statut_dossier: "validee",
          date_soumission: "2026-09-15T00:00:00.000Z",
        });
        return await ctx.db.insert("abo_personnes", {
          dossier_id: dossierId, nom: "DUPONT", prenom: "Camille",
          nom_prenom_normalise: "DUPONT CAMILLE", licence, licence_statut: "saisie",
          etape_demande: true, etape_validation: "validee", etape_licence: false,
          etape_inscription_site: false, etape_photo: false, etape_paiement: false,
          etape_abonnement_valide: false,
        });
      };
      const cibleId = await creer("cible@example.test", "111111111111");
      await creer("homonyme@example.test", "333333333333");
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "222222222222", nom: "DUPONT", prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE", abonnement_valide: "oui",
      });
      return { cibleId };
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect((await t.run((ctx) => ctx.db.get(cibleId)))?.licence).toBe("111111111111");
  });

  test("ne corrige pas vers une licence déjà portée", async () => {
    const t = convexTest(schema, modules);
    const { cibleId } = await t.run(async (ctx) => {
      const creer = async (email: string, prenom: string, licence: string) => {
        const ownerId = await ctx.db.insert("users", { email });
        const dossierId = await ctx.db.insert("abo_dossiers", {
          email, owner_id: ownerId, statut_dossier: "validee",
          date_soumission: "2026-09-15T00:00:00.000Z",
        });
        return await ctx.db.insert("abo_personnes", {
          dossier_id: dossierId, nom: "DUPONT", prenom,
          nom_prenom_normalise: `DUPONT ${prenom.toUpperCase()}`, licence, licence_statut: "saisie",
          etape_demande: true, etape_validation: "validee", etape_licence: false,
          etape_inscription_site: false, etape_photo: false, etape_paiement: false,
          etape_abonnement_valide: false,
        });
      };
      const cibleId = await creer("cible@example.test", "Camille", "111111111111");
      await creer("porteuse@example.test", "Alex", "222222222222");
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "222222222222", nom: "DUPONT", prenom: "Camille",
        nom_prenom_normalise: "DUPONT CAMILLE", abonnement_valide: "oui",
      });
      return { cibleId };
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect((await t.run((ctx) => ctx.db.get(cibleId)))?.licence).toBe("111111111111");
  });

  test("conserve l'ancienne licence tant qu'elle existe dans le snapshot", async () => {
    const t = convexTest(schema, modules);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "ancienne@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "ancienne@example.test", owner_id: ownerId,
        statut_dossier: "validee", date_soumission: "2026-09-15T00:00:00.000Z",
      });
      const id = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "GUIGO", prenom: "Olivia", nom_prenom_normalise: "GUIGO OLIVIA",
        licence: "748020279182", licence_statut: "saisie",
        etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false,
        etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279182", nom: "AUTRE", prenom: "Personne",
        nom_prenom_normalise: "AUTRE PERSONNE", abonnement_valide: "oui",
      });
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748020279190", nom: "GUIGO", prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA", abonnement_valide: "oui",
      });
      return id;
    });

    await t.mutation(internal.abo.matching.matcherScrapPersonnes, {});
    expect((await t.run((ctx) => ctx.db.get(personneId)))?.licence).toBe("748020279182");
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
