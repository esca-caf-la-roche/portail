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
});
