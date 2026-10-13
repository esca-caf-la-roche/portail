/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const saison = "2026-27";
const paginationOpts = { cursor: null, numItems: 25 };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const result = [];
    for (const name of ["Créateur", "Assigné", "Observateur", "Historique", "Public"]) {
      const id = await ctx.db.insert("users", { name, email: `${name}@example.test` });
      if (name !== "Public") await ctx.db.insert("userSettings", { userId: id, role: "admin", allowedTiles: name === "Historique" ? [] : ["taches"] });
      result.push(id);
    }
    const saisonId = await ctx.db.insert("saisons", { nom: saison, isDefault: false });
    return { users: result, saisonId };
  });
  const [createur, assigne, autre, historique, publicId] = ids.users;
  return { t, ...ids, createur, assigne, autre, historique, publicId, staff: t.withIdentity({ subject: createur }) };
}

test("droits réels, statut partagé, saisons et suppression référentielle", async () => {
  const { t, staff, createur, assigne, autre, historique, publicId, saisonId } = await setup();
  const args = { saison, titre: "Préparer", assigneIds: [assigne] };
  const id = await staff.mutation(api.taches.create, args);
  for (const subject of [historique, publicId]) await expect(t.withIdentity({ subject }).query(api.taches.list, { saison, paginationOpts })).rejects.toThrow();
  await expect(t.query(api.taches.list, { saison, paginationOpts })).rejects.toThrow();
  expect((await t.withIdentity({ subject: autre }).query(api.taches.list, { saison, paginationOpts })).page).toHaveLength(1);
  for (const subject of [assigne, autre]) {
    await expect(t.withIdentity({ subject }).mutation(api.taches.update, { ...args, id })).rejects.toThrow("créateur");
    await expect(t.withIdentity({ subject }).mutation(api.taches.remove, { saison, id })).rejects.toThrow("créateur");
  }
  await expect(t.withIdentity({ subject: autre }).mutation(api.taches.setStatus, { saison, id, statut: "terminee" })).rejects.toThrow();
  await t.withIdentity({ subject: assigne }).mutation(api.taches.setStatus, { saison, id, statut: "en_cours" });
  expect((await staff.query(api.taches.list, { saison, paginationOpts, assigneId: assigne, statut: "en_cours" })).page[0]).toMatchObject({ _id: id, statut: "en_cours" });
  expect((await staff.query(api.taches.list, { saison, paginationOpts, assigneId: assigne, statut: "a_faire" })).page).toHaveLength(0);
  await expect(staff.mutation(api.taches.setStatus, { saison: "2025-26", id, statut: "terminee" })).rejects.toThrow();
  expect((await staff.query(api.taches.list, { saison: "2025-26", paginationOpts })).page).toHaveLength(0);
  await expect(staff.mutation(api.saisons.remove, { id: saisonId })).rejects.toThrow("tâches");
  for (const userId of [createur, assigne]) await expect(staff.mutation(api.users.removeUser, { userId })).rejects.toThrow("tâches");
  await staff.mutation(api.taches.remove, { saison, id });
  expect(await t.run(ctx => ctx.db.query("taches_assignations").take(1))).toHaveLength(0);
  await staff.mutation(api.saisons.remove, { id: saisonId });
});

test("validation, idempotence et réassignation atomique", async () => {
  const { t, staff, assigne, autre, publicId } = await setup();
  const args = { saison, titre: "Préparer", assigneIds: [assigne], description: "Texte", echeance: "2028-02-29" };
  for (const invalid of [{ titre: " " }, { titre: "a".repeat(161) }, { description: "a".repeat(4001) }, { echeance: "2027-02-29" }, { assigneIds: [] }, { assigneIds: [assigne, assigne] }, { assigneIds: [publicId] }, { assigneIds: Array(51).fill(assigne) }]) {
    await expect(staff.mutation(api.taches.create, { ...args, ...invalid })).rejects.toThrow();
  }
  const id = await staff.mutation(api.taches.create, args);
  const before = await t.run(ctx => ctx.db.get(id));
  await staff.mutation(api.taches.update, { ...args, id });
  await staff.mutation(api.taches.setStatus, { saison, id, statut: "a_faire" });
  expect(await t.run(ctx => ctx.db.get(id))).toEqual(before);
  await staff.mutation(api.taches.update, { saison, id, titre: "Nouveau", assigneIds: [autre] });
  expect((await staff.query(api.taches.list, { saison, paginationOpts, assigneId: assigne })).page).toHaveLength(0);
  expect((await staff.query(api.taches.list, { saison, paginationOpts, assigneId: autre })).page[0]).toMatchObject({ titre: "Nouveau", assigneIds: [autre] });
  expect(await t.run(ctx => ctx.db.get(id))).not.toHaveProperty("echeance");
  await expect(t.withIdentity({ subject: assigne }).mutation(api.taches.setStatus, { saison, id, statut: "terminee" })).rejects.toThrow();
});

test("rattrapage obligatoire persisté, sans promotion publique, annuaire minimal", async () => {
  const { t, staff, historique, publicId } = await setup();
  const old = t.withIdentity({ subject: historique });
  await old.mutation(api.users.ensureMandatoryTiles, {});
  const first = await old.query(api.users.getCurrentUserSettings, {});
  expect(first.allowedTiles).toEqual(["taches"]);
  await old.mutation(api.users.ensureMandatoryTiles, {});
  expect(await old.query(api.users.getCurrentUserSettings, {})).toEqual(first);
  await t.withIdentity({ subject: publicId }).mutation(api.users.ensureMandatoryTiles, {});
  expect(await t.run(ctx => ctx.db.query("userSettings").withIndex("by_userId", q => q.eq("userId", publicId)).first())).toBeNull();
  const newId = await staff.mutation(api.users.addUser, { email: "new@example.test", name: "Nouveau" });
  await staff.mutation(api.users.updateUserSettings, { userId: newId, allowedTiles: [], role: "user", name: "Nouveau" });
  expect((await t.withIdentity({ subject: newId }).query(api.users.getCurrentUserSettings, {})).allowedTiles).toEqual(["taches"]);
  const annuaire = await staff.query(api.taches.annuaireStaff, {});
  expect(annuaire).toHaveLength(5);
  expect(annuaire.every(row => Object.keys(row).sort().join() === "nom,userId")).toBe(true);
});

test("pagination 25 et filtres combinés sans perte", async () => {
  const { staff, assigne } = await setup();
  for (let i = 0; i < 27; i++) await staff.mutation(api.taches.create, { saison, titre: `Tâche ${i}`, assigneIds: [assigne] });
  const first = await staff.query(api.taches.list, { saison, paginationOpts, assigneId: assigne, statut: "a_faire" });
  expect(first.page).toHaveLength(25);
  const second = await staff.query(api.taches.list, { saison, paginationOpts: { ...paginationOpts, cursor: first.continueCursor }, assigneId: assigne, statut: "a_faire" });
  expect(second.page).toHaveLength(2);
  expect(new Set([...first.page, ...second.page].map(row => row._id)).size).toBe(27);
});
