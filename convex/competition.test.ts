/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AmbassadeurFields, ImportRow } from "./competitionModel";

const modules = import.meta.glob("./**/*.ts");
const fields: AmbassadeurFields = { nom: "Exemple", prenom: "Camille", dateNaissance: "2005-02-03", civilite: "", categories: "U21", colonne1: "", groupe: "Groupe A", email: "camille@example.test" };
const saison = "2026-27";
const paginationOpts = { cursor: null, numItems: 50, maximumRowsRead: 100 };

async function setup() {
  const t = convexTest(schema, modules);
  const { id, saisonId } = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "staff@example.test" });
    await ctx.db.insert("userSettings", { userId: id, role: "admin", allowedTiles: ["competition"] });
    const saisonId = await ctx.db.insert("saisons", { nom: saison, isDefault: false });
    await ctx.db.insert("saisons", { nom: "2025-26", isDefault: true });
    return { id, saisonId };
  });
  return { t, staff: t.withIdentity({ subject: id }), saisonId, operatorId: id };
}

describe("compétition : sécurité, saisons et concurrence", () => {
  test("bootstrap sans aucun compte applicatif : provenance technique uniquement", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("saisons", { nom: saison, isDefault: true }));
    const rows = Array.from({ length: 27 }, (_, i) => ({ ...fields, nom: `Technique ${i}`, saison, partenariatSigne: false }));
    expect(await t.mutation(internal.competition.bootstrapInitialSeason, { saison: "2026-27", rows })).toEqual({ created: 27, unchanged: 0 });
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("userSettings").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("competition_ambassadeurs").collect())).every((r) => r.updatedBy === undefined && r.updatedSource === "bootstrap")).toBe(true);
  });
  test("bootstrap strict27 : créations, répétition sans write et refus atomiques", async () => {
    const { t, staff } = await setup();
    const rows = Array.from({ length: 27 }, (_, i) => ({ ...fields, nom: `Initial ${i}`, saison, partenariatSigne: false }));
    const args = { saison: "2026-27" as const, rows };
    const settingsBefore = await t.run((ctx) => ctx.db.query("userSettings").collect());
    for (const invalid of [rows.slice(1), [...rows, { ...rows[0], nom: "Extra" }]]) await expect(t.mutation(internal.competition.bootstrapInitialSeason, { ...args, rows: invalid })).rejects.toThrow("27");
    expect(await t.mutation(internal.competition.bootstrapInitialSeason, args)).toEqual({ created: 27, unchanged: 0 });
    const before = await t.run((ctx) => ctx.db.query("competition_ambassadeurs").collect());
    expect(before.every((r) => r.updatedBy === undefined && r.updatedSource === "bootstrap")).toBe(true);
    expect(await t.mutation(internal.competition.bootstrapInitialSeason, args)).toEqual({ created: 0, unchanged: 27 });
    expect(await t.run((ctx) => ctx.db.query("competition_ambassadeurs").collect())).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("userSettings").collect())).toEqual(settingsBefore);
    await expect(t.mutation(internal.competition.bootstrapInitialSeason, { ...args, rows: rows.map((r, i) => i === 26 ? { ...r, groupe: "Divergent" } : r) })).rejects.toThrow("divergentes");
    await expect(t.mutation(internal.competition.bootstrapInitialSeason, { ...args, rows: rows.map((r, i) => i === 26 ? { ...r, partenariatSigne: true } : r) })).rejects.toThrow("27");
    await staff.mutation(api.competition.update, { saison, id: before[26]._id, revision: 1, fields: { ...fields, nom: rows[26].nom }, partenariatSigne: true });
    await expect(t.mutation(internal.competition.bootstrapInitialSeason, args)).rejects.toThrow("divergentes");
    expect(await t.run((ctx) => ctx.db.get(before[26]._id))).toMatchObject({ partenariatSigne: true, revision: 2 });
  });

  test("bootstrap technique : ligne étrangère refusée et aucun droit attribué", async () => {
    const { t, operatorId, staff } = await setup();
    const rows = Array.from({ length: 27 }, (_, i) => ({ ...fields, nom: `Initial ${i}`, saison, partenariatSigne: false }));
    const args = { saison: "2026-27" as const, rows };
    const settingsId = await t.run(async (ctx) => (await ctx.db.query("userSettings").withIndex("by_userId", (q) => q.eq("userId", operatorId)).unique())!._id);
    await t.run((ctx) => ctx.db.patch(settingsId, { allowedTiles: [] }));
    // Opération serveur explicite indépendante des tuiles, sans les attribuer.
    const foreign = await t.run((ctx) => ctx.db.insert("competition_ambassadeurs", { ...fields, saison, cleIdentite: "foreign", partenariatSigne: false, revision: 1, updatedAt: 0, updatedBy: operatorId }));
    await expect(t.mutation(internal.competition.bootstrapInitialSeason, args)).rejects.toThrow("étrangères");
    expect(await t.run((ctx) => ctx.db.query("competition_ambassadeurs").collect())).toHaveLength(1);
    await t.run((ctx) => ctx.db.delete(foreign));
    expect((await t.mutation(internal.competition.bootstrapInitialSeason, args)).created).toBe(27);
    await expect(staff.query(api.competition.list, { saison, paginationOpts })).rejects.toThrow("attribué");
  });
  test("refuse chaque endpoint aux anonymes, abonnés publics et admins sans tuile", async () => {
    const { t } = await setup();
    const [adminId, publicId] = await t.run(async (ctx) => {
      const admin = await ctx.db.insert("users", { email: "admin@example.test" });
      await ctx.db.insert("userSettings", { userId: admin, role: "admin", allowedTiles: [] });
      const publicId = await ctx.db.insert("users", { email: "public@example.test" });
      return [admin, publicId];
    });
    const fakeId = await t.run((ctx) => ctx.db.insert("competition_ambassadeurs", { ...fields, saison, cleIdentite: "test", partenariatSigne: false, revision: 1, updatedAt: 0, updatedBy: adminId }));
    for (const denied of [t, t.withIdentity({ subject: adminId }), t.withIdentity({ subject: publicId })]) {
      await expect(denied.query(api.competition.list, { saison, paginationOpts })).rejects.toThrow();
      await expect(denied.query(api.competition.previewImport, { saison, rows: [fields] })).rejects.toThrow();
      await expect(denied.mutation(api.competition.create, { saison, fields, partenariatSigne: false })).rejects.toThrow();
      await expect(denied.mutation(api.competition.update, { saison, id: fakeId, revision: 1, fields, partenariatSigne: true })).rejects.toThrow();
      await expect(denied.mutation(api.competition.remove, { saison, id: fakeId, revision: 1 })).rejects.toThrow();
      await expect(denied.mutation(api.competition.importRows, { saison, plans: [] })).rejects.toThrow();
    }
  });

  test("CRUD isolé, identité normalisée, no-op et révisions", async () => {
    const { t, staff } = await setup();
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    const before = await t.run((ctx) => ctx.db.get(id));
    await expect(staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: " EXEMPLE " }, partenariatSigne: false })).rejects.toThrow("existe déjà");
    await staff.mutation(api.competition.create, { saison: "2025-26", fields, partenariatSigne: true });
    expect((await staff.query(api.competition.list, { saison, paginationOpts })).page).toHaveLength(1);
    await staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: false });
    expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
    await staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: true });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ revision: 2, partenariatSigne: true });
    await expect(staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: false })).rejects.toThrow("Conflit");
    await expect(staff.mutation(api.competition.remove, { saison: "2025-26", id, revision: 2 })).rejects.toThrow("cette saison");
    await expect(staff.mutation(api.competition.remove, { saison, id, revision: 1 })).rejects.toThrow("Conflit");
    await staff.mutation(api.competition.remove, { saison, id, revision: 2 });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  test("validation dates, champs, saison, pagination et suppression saison", async () => {
    const { staff, saisonId } = await setup();
    for (const invalid of [{ ...fields, dateNaissance: "2005-02-29" }, { ...fields, nom: "" }, { ...fields, email: "a@b.test,c@d.test" }, { ...fields, groupe: "a".repeat(201) }, { ...fields, colonne1: "a\nb" }]) {
      await expect(staff.mutation(api.competition.create, { saison, fields: invalid, partenariatSigne: false })).rejects.toThrow();
    }
    await expect(staff.query(api.competition.list, { saison: "2030-31", paginationOpts })).rejects.toThrow("introuvable");
    await expect(staff.query(api.competition.list, { saison: "2026-28", paginationOpts })).rejects.toThrow("invalide");
    await expect(staff.query(api.competition.list, { saison, paginationOpts: { ...paginationOpts, numItems: 51 } })).rejects.toThrow("Pagination");
    await expect(staff.query(api.competition.list, { saison, paginationOpts: { ...paginationOpts, maximumRowsRead: 101 } })).rejects.toThrow("Pagination");
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    await expect(staff.mutation(api.saisons.remove, { id: saisonId })).rejects.toThrow("ambassadeurs");
    await staff.mutation(api.competition.remove, { saison, id, revision: 1 });
    await staff.mutation(api.saisons.remove, { id: saisonId });
  });

  test("import idempotent, signature préservée puis remplacement manuel explicite", async () => {
    const { t, staff } = await setup();
    const preview = await staff.query(api.competition.previewImport, { saison, rows: [fields] });
    expect(preview[0].action).toBe("creation");
    expect(await staff.mutation(api.competition.importRows, { saison, plans: preview })).toEqual({ created: 1, updated: 0, unchanged: 0 });
    const id = (await staff.query(api.competition.list, { saison, paginationOpts })).page[0]._id;
    await staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: true });
    const before = await t.run((ctx) => ctx.db.get(id));
    const repeat = await staff.query(api.competition.previewImport, { saison, rows: [fields] });
    expect(repeat[0].action).toBe("identique");
    expect(await staff.mutation(api.competition.importRows, { saison, plans: repeat })).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
    const explicit = await staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, partenariatSigne: false, id, revision: 2, saison }] });
    await staff.mutation(api.competition.importRows, { saison, plans: explicit });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ partenariatSigne: false, revision: 3 });
  });

  test("doublons, imports bornés et métadonnées de saison refusés", async () => {
    const { staff } = await setup();
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    const invalid: ImportRow[][] = [[], [fields, { ...fields, nom: "EXEMPLE" }], Array.from({ length: 201 }, (_, i) => ({ ...fields, nom: `Test ${i}` })), [{ ...fields, id }], [{ ...fields, saison: "2025-26" }], [{ ...fields, id, revision: 1 }, { ...fields, nom: "Autre", id, revision: 1 }]];
    for (const rows of invalid) await expect(staff.query(api.competition.previewImport, { saison, rows })).rejects.toThrow();
    await expect(staff.query(api.competition.previewImport, { saison: "2025-26", rows: [{ ...fields, id, revision: 1 }] })).rejects.toThrow("cette saison");
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...fields, nom: `Fictif ${i}` }));
    const plans = await staff.query(api.competition.previewImport, { saison, rows });
    expect((await staff.mutation(api.competition.importRows, { saison, plans })).created).toBe(200);
    const first = await staff.query(api.competition.list, { saison, paginationOpts });
    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    expect((await staff.query(api.competition.list, { saison, paginationOpts: { ...paginationOpts, cursor: first.continueCursor } })).page).toHaveLength(50);
  });

  test("conflit après preview et export périmé : aucun write partiel", async () => {
    const { t, staff } = await setup();
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    const plans = await staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, nom: "Nouveau" }, { ...fields, groupe: "B" }] });
    expect(plans[1].before).toEqual({ ...fields, partenariatSigne: false });
    expect(plans[1].row.groupe).toBe("B");
    await staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: true });
    await expect(staff.mutation(api.competition.importRows, { saison, plans })).rejects.toThrow("Conflit");
    expect((await staff.query(api.competition.list, { saison, paginationOpts })).page).toHaveLength(1);
    await expect(staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, id, revision: 1 }] })).rejects.toThrow("Conflit");
    const absent = await staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, nom: "Concurrent" }] });
    await staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: "Concurrent" }, partenariatSigne: false });
    await expect(staff.mutation(api.competition.importRows, { saison, plans: absent })).rejects.toThrow("Conflit");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ groupe: "Groupe A", partenariatSigne: true });
  });
});
