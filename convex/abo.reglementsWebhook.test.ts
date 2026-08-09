/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { validerReponseWebhook } from "./abo/reglementsWebhook";
import { REGLEMENT_VERSION } from "./abo/reglementsConstants";

const modules = import.meta.glob("./**/*.ts");

describe("webhook n8n des règlements", () => {
  test("valide le contrat, null et une réponse JSON doublement encodée", () => {
    const item = {
      NOM: " DUPONT ",
      Prénom: " Claire ",
      "id-drive": "drive_file-123",
    };
    expect(validerReponseWebhook([item])).toEqual([
      { nom: "DUPONT", prenom: "Claire", driveFileId: "drive_file-123" },
    ]);
    expect(validerReponseWebhook(null)).toEqual([]);
    expect(validerReponseWebhook("  \n")).toEqual([]);
    expect(validerReponseWebhook(JSON.stringify(JSON.stringify([item])))).toHaveLength(1);
  });

  test("refuse les formes invalides et les doublons contradictoires", () => {
    expect(() => validerReponseWebhook({})).toThrow("tableau JSON");
    expect(() => validerReponseWebhook([{ NOM: "DUPONT" }])).toThrow("Prénom");
    expect(() =>
      validerReponseWebhook([
        { NOM: "DUPONT", Prénom: "Claire", "id-drive": "same-id" },
        { NOM: "MARTIN", Prénom: "Luc", "id-drive": "same-id" },
      ]),
    ).toThrow("deux identités différentes");
  });

  test("l'upsert est idempotent et ne remet pas une archive dans la file", async () => {
    const t = convexTest(schema, modules);
    const synchroniseLe = "2026-08-09T12:00:00.000Z";
    const item = { nom: "DUPONT", prenom: "Claire", driveFileId: "drive-1" };

    await expect(
      t.mutation(internal.abo.reglementsWebhook.enregistrerResultat, {
        items: [item],
        synchroniseLe,
      }),
    ).resolves.toEqual({ crees: 1, actualises: 0, ignores: 0 });
    const avant = await t.run((ctx) =>
      ctx.db
        .query("abo_reglements_imports")
        .withIndex("by_drive_file_id", (q) => q.eq("drive_file_id", "drive-1"))
        .unique(),
    );
    await expect(
      t.mutation(internal.abo.reglementsWebhook.enregistrerResultat, {
        items: [item],
        synchroniseLe: "2026-08-09T13:00:00.000Z",
      }),
    ).resolves.toEqual({ crees: 0, actualises: 0, ignores: 1 });
    const apres = await t.run((ctx) => ctx.db.get(avant!._id));
    expect(apres).toEqual(avant);

    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "archive@example.test" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("abo_reglements_signes", {
        drive_file_id: "drive-archive",
        drive_file_name: "MARTIN Luc.pdf",
        drive_url: "https://drive.google.com/open?id=drive-archive",
        version_reglement: REGLEMENT_VERSION,
        nom: "MARTIN",
        prenom: "Luc",
        nom_prenom_normalise: "MARTIN LUC",
        licence: "123456789012",
        liaison_validee_par: userId,
        liaison_validee_le: synchroniseLe,
        statut_site: "a_enregistrer",
      }),
    );
    await expect(
      t.mutation(internal.abo.reglementsWebhook.enregistrerResultat, {
        items: [
          { nom: "MARTIN", prenom: "Luc", driveFileId: "drive-archive" },
        ],
        synchroniseLe,
      }),
    ).resolves.toEqual({ crees: 0, actualises: 0, ignores: 1 });
    await expect(
      t.run((ctx) =>
        ctx.db
          .query("abo_reglements_imports")
          .withIndex("by_drive_file_id", (q) =>
            q.eq("drive_file_id", "drive-archive"),
          )
          .unique(),
      ),
    ).resolves.toBeNull();
  });

  test("la liaison archive les vraies métadonnées Drive sans imposer le nom du signataire", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "admin@example.test" });
      await ctx.db.insert("userSettings", {
        userId: id,
        allowedTiles: ["abonnements"],
        role: "user",
      });
      await ctx.db.insert("abo_licences", {
        licence: "123456789012",
        nom: "DUPONT",
        prenom: "Claire",
        nom_prenom_normalise: "DUPONT CLAIRE",
        imported_at: "2026-08-09T00:00:00.000Z",
      });
      return id;
    });
    const importId = await t.run((ctx) =>
      ctx.db.insert("abo_reglements_imports", {
        drive_file_id: "drive-direct",
        drive_file_name: "DUPONT Claire.pdf",
        drive_url: "https://drive.google.com/open?id=drive-direct",
        version_reglement: REGLEMENT_VERSION,
        identite_extraite: "DUPONT Claire",
        nom_extrait: "DUPONT",
        prenom_extrait: "Claire",
        nom_prenom_normalise: "DUPONT CLAIRE",
        statut: "a_rapprocher",
        importe_le: "2026-08-09T12:00:00.000Z",
      }),
    );

    await expect(
      t.query(internal.abo.reglementsImports.contexteLiaisonDrive, {
        importId,
        licence: "123456789012",
      }),
    ).resolves.toEqual({
      kind: "a_verifier",
      driveFileId: "drive-direct",
      versionReglement: REGLEMENT_VERSION,
    });
    const reglement = await t.mutation(
      internal.abo.reglementsImports.finaliserLiaisonDrive,
      {
        importId,
        userId,
        licence: "123456789012",
        driveFileId: "drive-direct",
        driveFileName: "Règlement Intérieur Sept 24.pdf",
        driveUrl: "https://drive.google.com/file/d/drive-direct/view",
        versionReglement: REGLEMENT_VERSION,
      },
    );
    expect(reglement).toMatchObject({
      driveFileId: "drive-direct",
      nomFichier: "Règlement Intérieur Sept 24.pdf",
      licence: "123456789012",
    });
    await expect(t.run((ctx) => ctx.db.get(importId))).resolves.toMatchObject({
      statut: "lie",
      reglement_id: reglement.id,
      drive_file_name: "Règlement Intérieur Sept 24.pdf",
    });
    await expect(
      t.query(internal.abo.reglementsImports.contexteLiaisonDrive, {
        importId,
        licence: "123456789012",
      }),
    ).resolves.toMatchObject({ kind: "deja_lie", reglement });
  });
});
