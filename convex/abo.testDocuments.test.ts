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
  test("rend le test archivable à la fin du créneau, pas à son début", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    const personneId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "fin-creneau@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "fin-creneau@example.test",
        statut_dossier: "validee",
        date_soumission: "2026-09-01T00:00:00.000Z",
        owner_id: ownerId,
      });
      const id = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId,
        nom: "FIN",
        prenom: "Créneau",
        nom_prenom_normalise: "fin creneau",
        licence: "748020260001",
        licence_statut: "annuaire_valide",
        etape_demande: true,
        etape_validation: "validee",
        etape_licence: true,
        etape_test_autonomie: "requis",
        etape_inscription_site: false,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_test_reservations", {
        personne_id: id,
        tranche: "2026-09-16T08:00:00.000Z",
        tranche_fin: "2026-09-16T08:20:00.000Z",
        statut: "active",
      });
      return id;
    });

    await expect(admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2026-09-16T08:19:59.999Z",
    })).resolves.toEqual([]);
    const justeAvant = await admin.query(api.abo.testDocuments.rechercherCandidatParLicence, {
      licence: "748020260001",
      avant: "2026-09-16T08:19:59.999Z",
    });
    expect(justeAvant[0]).toMatchObject({ personneId, reservationPassee: false });

    const aLaFin = await admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2026-09-16T08:20:00.000Z",
    });
    expect(aLaFin).toEqual([expect.objectContaining({ personneId, reservationPassee: true })]);
    const rechercheALaFin = await admin.query(api.abo.testDocuments.rechercherCandidatParLicence, {
      licence: "748020260001",
      avant: "2026-09-16T08:20:00.000Z",
    });
    expect(rechercheALaFin[0]).toMatchObject({ personneId, reservationPassee: true });
  });

  test("applique une fin conservatrice à début plus 60 minutes aux réservations legacy", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260002",
        candidat_nom: "LEGACY",
        candidat_prenom: "Test",
        candidat_email: "legacy@example.test",
        tranche: "2026-09-16T08:00:00.000Z",
        statut: "active",
      });
    });

    await expect(admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2026-09-16T08:59:59.999Z",
    })).resolves.toEqual([]);
    await expect(admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2026-09-16T09:00:00.000Z",
    })).resolves.toEqual([
      expect.objectContaining({ licence: "748020260002", reservationPassee: true }),
    ]);
  });

  test("recherche un licencié avec les 4 ou 6 derniers chiffres de sa licence", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await ajouterLicence(t, "748020120024");
    await ajouterLicence(t, "748020240024");
    await ajouterLicence(t, "748020241234");

    const parSixChiffres = await admin.query(
      api.abo.testDocuments.rechercherCandidatParLicence,
      { licence: "120024", avant: "2026-09-16T10:00:00.000Z" },
    );
    const parQuatreChiffres = await admin.query(
      api.abo.testDocuments.rechercherCandidatParLicence,
      { licence: "0024", avant: "2026-09-16T10:00:00.000Z" },
    );

    expect(parSixChiffres.map((candidat) => candidat.licence)).toEqual(["748020120024"]);
    expect(parQuatreChiffres.map((candidat) => candidat.licence)).toEqual([
      "748020120024",
      "748020240024",
    ]);
  });

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

  test("qualifie une réservation terminée de façon idempotente et autorise une correction", async () => {
    const t = convexTest(schema, modules);
    const { userId, admin } = await creerAdmin(t);
    const reservationId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260099",
        candidat_nom: "RESULTAT",
        candidat_prenom: "Test",
        candidat_email: "resultat@example.test",
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
      });
      await ctx.db.insert("abo_tests_autonomie_archive", {
        reservation_id: id,
        resultat_test: "non_valide",
        licence: "748020260099",
        nom: "RESULTAT",
        prenom: "Test",
        nom_prenom_normalise: "resultat test",
        drive_file_id: "drive-resultat",
        drive_url: "https://drive.example/resultat",
        statut: "a_traiter",
      });
      return id;
    });

    await admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId,
      resultat: "non_valide",
    });
    const premiere = await t.run((ctx) => ctx.db.get(reservationId));
    expect(premiere).toMatchObject({
      resultat_test: "non_valide",
      resultat_renseigne_par: userId,
    });

    await admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId,
      resultat: "non_valide",
    });
    const identique = await t.run((ctx) => ctx.db.get(reservationId));
    expect(identique?.resultat_renseigne_le).toBe(premiere?.resultat_renseigne_le);

    await admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId,
      resultat: "absent",
    });
    const corrigee = await t.run((ctx) => ctx.db.get(reservationId));
    expect(corrigee?.resultat_test).toBe("absent");

    await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      candidat_licence: "748020260099",
      candidat_nom: "RESULTAT",
      candidat_prenom: "Test",
      candidat_email: "resultat@example.test",
      tranche: "2099-01-01T08:00:00.000Z",
      tranche_fin: "2099-01-01T08:20:00.000Z",
      statut: "active",
    }));
    await expect(admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId,
      resultat: "valide",
    })).rejects.toThrow("Annulez d'abord le nouveau créneau");
  });

  test("accepte absent sans document mais exige le formulaire pour validé ou non validé", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    const ids = await t.run(async (ctx) => ({
      absent: await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260091",
        candidat_nom: "ABSENT",
        candidat_prenom: "Test",
        candidat_email: "absent@example.test",
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
      }),
      valide: await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260092",
        candidat_nom: "SANS DOCUMENT",
        candidat_prenom: "Test",
        candidat_email: "sans-document@example.test",
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
      }),
    }));
    await t.run((ctx) => ctx.db.insert("abo_tests_autonomie_archive", {
      licence: "748020260092",
      nom: "ANCIEN",
      prenom: "Document",
      nom_prenom_normalise: "ancien document",
      drive_file_id: "ancien-drive-id",
      drive_url: "https://drive.example/ancien",
      statut: "traite",
    }));

    await expect(admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId: ids.absent,
      resultat: "absent",
    })).resolves.toMatchObject({ resultat: "absent" });
    await expect(admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId: ids.valide,
      resultat: "valide",
    })).rejects.toThrow("Déposez le formulaire");
    await expect(admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId: ids.valide,
      resultat: "non_valide",
    })).rejects.toThrow("Déposez le formulaire");
  });

  test("prépare une archive distincte pour chaque tentative de la même licence", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await ajouterLicence(t, "748020260093");
    const reservations = await t.run(async (ctx) => ({
      premiere: await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260093",
        candidat_nom: "DUPONT",
        candidat_prenom: "Claire",
        candidat_email: "claire@example.test",
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
      }),
      seconde: await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260093",
        candidat_nom: "DUPONT",
        candidat_prenom: "Claire",
        candidat_email: "claire@example.test",
        tranche: "2020-02-01T08:00:00.000Z",
        tranche_fin: "2020-02-01T08:20:00.000Z",
        statut: "active",
      }),
    }));

    const premiere = await admin.mutation(api.abo.testDocuments.preparerDepot, {
      licence: "748020260093",
      reservationId: reservations.premiere,
      resultat: "non_valide",
    });
    const seconde = await admin.mutation(api.abo.testDocuments.preparerDepot, {
      licence: "748020260093",
      reservationId: reservations.seconde,
      resultat: "valide",
    });

    expect(seconde.archiveId).not.toBe(premiere.archiveId);
    await expect(t.run(async (ctx) => Promise.all([
      ctx.db.get(premiere.archiveId),
      ctx.db.get(seconde.archiveId),
    ]))).resolves.toEqual([
      expect.objectContaining({
        reservation_id: reservations.premiere,
        resultat_test: "non_valide",
      }),
      expect.objectContaining({
        reservation_id: reservations.seconde,
        resultat_test: "valide",
      }),
    ]);
  });

  test("refuse un résultat avant la fin du créneau et sans accès Abonnements", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    const reservationId = await t.run((ctx) =>
      ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260098",
        candidat_nom: "FUTUR",
        candidat_prenom: "Test",
        candidat_email: "futur@example.test",
        tranche: "2099-01-01T08:00:00.000Z",
        tranche_fin: "2099-01-01T08:20:00.000Z",
        statut: "active",
      }),
    );
    await expect(admin.mutation(api.abo.testDocuments.renseignerResultatTest, {
      reservationId,
      resultat: "valide",
    })).rejects.toThrow("après la fin du créneau");

    const sansAccesId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        email: "sans-acces-resultat@example.test",
      });
      await ctx.db.insert("abo_profiles", {
        userId: id,
        email: "sans-acces-resultat@example.test",
        role: "utilisateur",
      });
      return id;
    });
    await expect(t.withIdentity({ subject: sansAccesId }).mutation(
      api.abo.testDocuments.renseignerResultatTest,
      { reservationId, resultat: "absent" },
    )).rejects.toThrow("Réservé aux administrateurs");
  });

  test("déduplique les tentatives dossier et directe par licence en gardant la plus récente", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    const ids = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "transition@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "transition@example.test",
        statut_dossier: "validee",
        date_soumission: "2020-01-01T00:00:00.000Z",
        owner_id: ownerId,
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId,
        nom: "TENTATIVE",
        prenom: "Test",
        nom_prenom_normalise: "tentative test",
        licence: "748020260097",
        licence_statut: "annuaire_valide",
        etape_demande: true,
        etape_validation: "validee",
        etape_licence: true,
        etape_test_autonomie: "requis",
        etape_inscription_site: false,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
      });
      const ancienne = await ctx.db.insert("abo_test_reservations", {
        personne_id: personneId,
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
        resultat_test: "non_valide",
      });
      const recente = await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748020260097",
        candidat_nom: "TENTATIVE",
        candidat_prenom: "Test",
        candidat_email: "tentative@example.test",
        tranche: "2020-02-01T08:00:00.000Z",
        tranche_fin: "2020-02-01T08:20:00.000Z",
        statut: "active",
        resultat_test: "valide",
      });
      return { ancienne, recente };
    });

    const liste = await admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2026-09-17T00:00:00.000Z",
    });
    expect(liste).toEqual([
      expect.objectContaining({
        reservationId: ids.recente,
        resultatTest: "valide",
      }),
    ]);
    expect(liste[0]?.reservationId).not.toBe(ids.ancienne);
  });
});
