/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { REGLEMENT_DOCUSEAL_URL, REGLEMENT_VERSION } from "./abo/reglementsConstants";
import { preparerRechercheDrive } from "./abo/driveArchivesRecherche";

const modules = import.meta.glob("./**/*.ts");

async function creerAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "reglements-admin@example.test" });
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
  licence: string,
  nom: string,
  prenom: string,
  cle: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("abo_licences", {
      licence,
      nom,
      prenom,
      nom_prenom_normalise: cle,
      imported_at: "2026-08-09T00:00:00.000Z",
    }),
  );
}

async function lier(
  t: ReturnType<typeof convexTest>,
  userId: Awaited<ReturnType<typeof creerAdmin>>["userId"],
  licence: string,
  driveFileId = "drive-file-1",
  driveFileName = "DUPONT Claire.pdf",
) {
  return await t.mutation(internal.abo.reglements.lierReglementInterne, {
    userId,
    licence,
    driveFileId,
    driveFileName,
    driveUrl: `https://drive.google.com/open?id=${driveFileId}`,
    versionReglement: REGLEMENT_VERSION,
  });
}

describe("règlements signés", () => {
  test("recherche par nom, prénom ou fragment et reste admin-only", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");
    await ajouterLicence(t, "987654321098", "Claire", "DUPONT", "CLAIRE DUPONT");
    await ajouterLicence(t, "111111111111", "DUPONT", "Clara", "DUPONT CLARA");

    await expect(
      admin.query(api.abo.reglements.rechercherLicencesParNom, {
        nom: "Dupont",
        prenom: "Claire",
      }),
    ).resolves.toEqual([
      { licence: "123456789012", nom: "DUPONT", prenom: "Claire" },
    ]);
    await expect(
      admin.query(api.abo.reglements.rechercherLicencesParNom, {
        nom: "dup",
        prenom: "",
      }),
    ).resolves.toEqual([
      { licence: "123456789012", nom: "DUPONT", prenom: "Claire" },
      { licence: "111111111111", nom: "DUPONT", prenom: "Clara" },
    ]);
    await expect(
      admin.query(api.abo.reglements.rechercherLicencesParNom, {
        nom: "",
        prenom: "lar",
      }),
    ).resolves.toEqual([
      { licence: "111111111111", nom: "DUPONT", prenom: "Clara" },
    ]);

    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "sans-tuile@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: id,
        email: "sans-tuile@example.test",
        role: "utilisateur",
      });
      return id;
    });
    await expect(
      t.withIdentity({ subject: userId }).query(
        api.abo.reglements.rechercherLicencesParNom,
        { nom: "Dupont", prenom: "Claire" },
      ),
    ).rejects.toThrow("Réservé aux administrateurs");
  });

  test("la liaison est idempotente et bloque les conflits de fichier ou de licence", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");
    await ajouterLicence(t, "987654321098", "MARTIN", "Luc", "MARTIN LUC");

    const premiere = await lier(t, userId, "123456789012");
    const reprise = await lier(t, userId, "123456789012");
    expect(reprise.id).toBe(premiere.id);
    expect(reprise).toMatchObject({
      licence: "123456789012",
      statut: "a_enregistrer",
      nomFichier: "DUPONT Claire.pdf",
    });

    await expect(
      lier(t, userId, "987654321098", "drive-file-1", "MARTIN Luc.pdf"),
    ).rejects.toThrow(
      "déjà lié à une autre licence",
    );
    await expect(
      lier(t, userId, "123456789012", "drive-file-2"),
    ).rejects.toThrow("déjà lié à cette licence");
  });

  test("refuse de lier un fichier dont le nom ne correspond pas à la licence", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");

    await expect(
      t.mutation(internal.abo.reglements.lierReglementInterne, {
        userId,
        licence: "123456789012",
        driveFileId: "drive-file-mismatch",
        driveFileName: "MARTIN Luc.pdf",
        driveUrl: "https://drive.google.com/open?id=drive-file-mismatch",
        versionReglement: REGLEMENT_VERSION,
      }),
    ).rejects.toThrow("ne correspond pas au nom et au prénom");
  });

  test("refuse une version inconnue et une licence absente", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await creerAdmin(t);
    await expect(
      t.mutation(internal.abo.reglements.lierReglementInterne, {
        userId,
        licence: "123456789012",
        driveFileId: "drive-file",
        driveFileName: "DUPONT Claire.pdf",
        driveUrl: "https://drive.google.com/open?id=drive-file",
        versionReglement: "ancienne-version",
      }),
    ).rejects.toThrow("version du règlement");
    await expect(lier(t, userId, "123456789012")).rejects.toThrow(
      "n'existe pas dans l'annuaire",
    );
  });

  test("liste, compte et changement de statut sont bornés et idempotents", async () => {
    const t = convexTest(schema, modules);
    const { userId, admin } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");
    const reglement = await lier(t, userId, "123456789012");

    await expect(admin.query(api.abo.reglements.compterAEnregistrer, {})).resolves.toBe(1);
    await expect(
      admin.query(api.abo.reglements.lister, {
        statut: "a_enregistrer",
        paginationOpts: { numItems: 25, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [reglement], isDone: true });

    const premier = await admin.mutation(api.abo.reglements.marquerEnregistreSite, {
      reglementId: reglement.id,
    });
    const reprise = await admin.mutation(api.abo.reglements.marquerEnregistreSite, {
      reglementId: reglement.id,
    });
    expect(reprise).toEqual(premier);
    expect(reprise.statut).toBe("enregistre");
    await expect(admin.query(api.abo.reglements.compterAEnregistrer, {})).resolves.toBe(0);
  });

  test("monSuivi reconnaît uniquement la licence exacte pour la version courante", async () => {
    const t = convexTest(schema, modules);
    const { userId: adminId } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");
    const owner = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "owner@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: ownerId,
        email: "owner@example.test",
        role: "utilisateur",
      });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "owner@example.test",
        owner_id: ownerId,
        statut_dossier: "validee",
        date_soumission: "2026-08-09T00:00:00.000Z",
      });
      const base = {
        dossier_id: dossierId,
        licence_statut: "saisie" as const,
        etape_demande: true,
        etape_validation: "validee" as const,
        etape_licence: true,
        etape_inscription_site: false,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
      };
      await ctx.db.insert("abo_personnes", {
        ...base,
        nom: "DUPONT",
        prenom: "Claire",
        nom_prenom_normalise: "DUPONT CLAIRE",
        licence: "123456789012",
      });
      await ctx.db.insert("abo_personnes", {
        ...base,
        nom: "DUPONT",
        prenom: "Claire",
        nom_prenom_normalise: "DUPONT CLAIRE",
        licence: "111111111111",
      });
      return ownerId;
    });
    await lier(t, adminId, "123456789012");

    const suivi = await t.withIdentity({ subject: owner }).query(api.abo.demandes.monSuivi, {});
    expect(suivi.map((personne) => personne.reglement_signe)).toEqual([
      true,
      false,
    ]);
  });

  test("monSuivi ne révèle rien pour une licence seulement saisie", async () => {
    const t = convexTest(schema, modules);
    const { userId: adminId } = await creerAdmin(t);
    await ajouterLicence(t, "123456789012", "DUPONT", "Claire", "DUPONT CLAIRE");
    await lier(t, adminId, "123456789012");
    const owner = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { email: "oracle@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: ownerId,
        email: "oracle@example.test",
        role: "utilisateur",
      });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "oracle@example.test",
        owner_id: ownerId,
        statut_dossier: "validee",
        date_soumission: "2026-08-09T00:00:00.000Z",
      });
      await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId,
        nom: "DUPONT",
        prenom: "Claire",
        nom_prenom_normalise: "DUPONT CLAIRE",
        licence: "123456789012",
        licence_statut: "saisie",
        etape_demande: true,
        etape_validation: "validee",
        etape_licence: true,
        etape_inscription_site: false,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
      });
      return ownerId;
    });

    const suivi = await t.withIdentity({ subject: owner }).query(api.abo.demandes.monSuivi, {});
    expect(suivi[0]?.reglement_signe).toBe(false);
  });

  test("le lien DocuSeal courant est exposé dans les liens de finalisation", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await creerAdmin(t);
    await expect(admin.query(api.abo.config.liensFinalisation, {})).resolves.toMatchObject({
      reglement: REGLEMENT_DOCUSEAL_URL,
    });
  });

});

describe("préparation de la recherche commune dans Drive", () => {
  const dossiers = [
    { id: "dossier-h", nom: "H" },
    { id: "dossier-d", nom: "D" },
    { id: "dossier-a", nom: "A" },
  ];

  test("accepte un fragment de nom seul", () => {
    const recherche = preparerRechercheDrive("duh", "", dossiers);
    expect(recherche.morceaux).toEqual(["name contains 'DUH'"]);
    expect(recherche.dossierIds[0]).toBe("dossier-d");
  });

  test("accepte un fragment pris au milieu du nom", () => {
    const recherche = preparerRechercheDrive("her", "", dossiers);
    expect(recherche.morceaux).toEqual(["name contains 'HER'"]);
    expect(recherche.dossierIds).toEqual([
      "dossier-h",
      "dossier-a",
      "dossier-d",
    ]);
  });

  test("accepte un fragment de prénom seul", () => {
    const recherche = preparerRechercheDrive("", "jea", dossiers);
    expect(recherche.morceaux).toEqual(["name contains 'Jea'"]);
    expect(recherche.dossierIds).toEqual([
      "dossier-a",
      "dossier-d",
      "dossier-h",
    ]);
  });

  test("combine les fragments de nom et de prénom", () => {
    expect(preparerRechercheDrive("mar", "lou", dossiers).morceaux).toEqual([
      "name contains 'MAR'",
      "name contains 'Lou'",
    ]);
  });
});
