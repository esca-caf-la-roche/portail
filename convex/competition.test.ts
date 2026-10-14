/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { GROUPES, type AmbassadeurFields, type ImportRow } from "./competitionModel";
import { validerReponseArkose } from "./competitionArkoseWebhook";

const modules = import.meta.glob("./**/*.ts");
const fields: AmbassadeurFields = { nom: "Exemple", prenom: "Camille", dateNaissance: "2005-02-03", civilite: "Homme", categories: "Compétiteur", groupe: "Groupe Perf.", email: "camille@example.test" };
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
  test("email Arkose : alias, absences, limites et doublons", () => {
    const identity = { nom: "Parent", prenom: "Camille" };
    for (const alias of ["email", "Email", "EMAIL"]) {
      expect(validerReponseArkose([{ ...identity, [alias]: " Parent@Example.test " }])).toEqual([{ ...identity, email: "parent@example.test" }]);
      for (const empty of [null, "", "   "]) expect(validerReponseArkose([{ ...identity, [alias]: empty }])).toEqual([identity]);
    }
    expect(validerReponseArkose([identity])).toEqual([identity]);
    expect(validerReponseArkose([{ ...identity, " email ": " parent@example.test " }])).toEqual([{ ...identity, email: "parent@example.test" }]);
    expect(validerReponseArkose([{ ...identity, "Émail": "Parent@Example.test" }])).toEqual([{ ...identity, email: "parent@example.test" }]);
    expect(() => validerReponseArkose([{ ...identity, email: "a@b.test", " email ": "a@b.test" }])).toThrow("plusieurs champs");
    const withEmail = { ...identity, email: "parent@example.test" };
    for (const rows of [[withEmail, identity], [identity, withEmail], [withEmail, { ...identity, Email: " PARENT@EXAMPLE.TEST " }]]) expect(validerReponseArkose(rows)).toEqual([withEmail]);
    expect(() => validerReponseArkose([withEmail, { ...identity, email: "other@example.test" }])).toThrow("emails différents");
    expect(() => validerReponseArkose([{ ...identity, email: null, EMAIL: "" }])).toThrow("plusieurs champs");
    for (const email of [12, {}, [], "a b@c.test", "a@b", "a@@b.test", "a@b.test,c@d.test", `${"a".repeat(248)}@b.test`]) expect(() => validerReponseArkose([{ ...identity, email }])).toThrow("email invalide");
    expect(validerReponseArkose([{ ...identity, email: `${"a".repeat(247)}@b.test` }])[0].email).toHaveLength(254);
  });

  test("lien PDF Arkose : alias, validation, absences et doublons", () => {
    const identity = { nom: "Parent", prenom: "Camille" };
    const url = "https://drive.google.com/file/d/abc/view";
    for (const alias of ["lien", "Lien", "lien_pdf"]) expect(validerReponseArkose([{ ...identity, [alias]: url }])).toEqual([{ ...identity, lien: url }]);
    for (const empty of [null, "", "   "]) expect(validerReponseArkose([{ ...identity, lien: empty }])).toEqual([identity]);
    expect(validerReponseArkose([identity])).toEqual([identity]);
    for (const lien of ["http://drive.google.com/x", "javascript:alert(1)", "https://a b", 12, {}, [], `https://${"a".repeat(500)}`]) expect(() => validerReponseArkose([{ ...identity, lien }])).toThrow("lien invalide");
    expect(() => validerReponseArkose([{ ...identity, lien: url, Lien: url }])).toThrow("plusieurs champs");
    expect(() => validerReponseArkose([{ ...identity, lien: url }, { ...identity, lien: "https://drive.google.com/file/d/other/view" }])).toThrow("liens différents");
    expect(validerReponseArkose([{ ...identity, lien: url }, { ...identity }])).toEqual([{ ...identity, lien: url }]);
  });

  test("lien PDF Arkose : stockage, enrichissement sans effacement et exposition", async () => {
    const { t, staff, operatorId } = await setup();
    const url = "https://drive.google.com/file/d/abc/view";
    const lot = (items: { nom: string; prenom: string; email?: string; lien?: string }[]) => t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items });
    await lot([{ nom: "Exemple", prenom: "Camille", lien: url }]);
    const [signature] = await staff.query(api.competition.listSignaturesArkose, { saison });
    expect(signature.lienPdf).toBe(url);
    await lot([{ nom: "Exemple", prenom: "Camille" }]);
    expect((await staff.query(api.competition.listSignaturesArkose, { saison }))[0].lienPdf).toBe(url);
    const url2 = "https://drive.google.com/file/d/def/view";
    await lot([{ nom: "Exemple", prenom: "Camille", lien: url2 }]);
    expect((await t.run((ctx) => ctx.db.query("competition_signatures_arkose").collect()))[0].lienPdf).toBe(url2);
    await lot([{ nom: "Autre", prenom: "Test", lien: "" }]);
    const autre = (await t.run((ctx) => ctx.db.query("competition_signatures_arkose").collect())).find((row) => row.nom === "Autre");
    expect(autre).not.toHaveProperty("lienPdf");
  });

  test("Arkose : filtres indépendants et enrichissement sans modifier les décisions", async () => {
    const { t, staff, operatorId } = await setup();
    const child = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items: [{ nom: "Exemple", prenom: "Camille", email: "initial@example.test" }, { nom: "Parent", prenom: "Autre" }, { nom: "Masque", prenom: "Autre" }] });
    const all = await staff.query(api.competition.listSignaturesArkose, { saison, inclureLiees: true });
    const linked = all.find((s) => s.statut === "lie")!;
    const hidden = all.find((s) => s.nom === "Masque")!;
    await staff.mutation(api.competition.masquerSignatureArkose, { saison, signatureId: hidden._id });
    for (const inclureLiees of [undefined, false, true]) for (const inclureMasquees of [undefined, false, true]) {
      const rows = await staff.query(api.competition.listSignaturesArkose, { saison, inclureLiees, inclureMasquees });
      expect(rows.map((s) => s.statut).sort()).toEqual(["a_rapprocher", ...(inclureLiees ? ["lie"] : []), ...(inclureMasquees ? ["masquee"] : [])].sort());
    }
    for (const signature of [linked, hidden]) {
      const before = await t.run((ctx) => ctx.db.get(signature._id));
      const linksBefore = await t.run((ctx) => ctx.db.query("competition_signatures_arkose_liens").collect());
      const childBefore = await t.run((ctx) => ctx.db.get(child));
      const args = { saison, userId: operatorId, items: [{ nom: signature.nom, prenom: signature.prenom, email: "new@example.test" }] };
      expect(await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, args)).toEqual({ queued: 0, autoLinked: 0, ignored: 1 });
      const enriched = await t.run((ctx) => ctx.db.get(signature._id));
      expect(enriched).toEqual({ ...before, email: "new@example.test" });
      await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, args);
      await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { ...args, items: [{ nom: signature.nom, prenom: signature.prenom }] });
      await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { ...args, items: [{ nom: signature.nom, prenom: signature.prenom, email: "" }] });
      expect(await t.run((ctx) => ctx.db.get(signature._id))).toEqual(enriched);
      expect(await t.run((ctx) => ctx.db.query("competition_signatures_arkose_liens").collect())).toEqual(linksBefore);
      expect(await t.run((ctx) => ctx.db.get(child))).toEqual(childBefore);
    }
    await expect(staff.mutation(api.competition.delierSignatureArkose, { saison: "2025-26", signatureId: linked._id, ambassadeurId: child })).rejects.toThrow("cette saison");
    await staff.mutation(api.competition.delierSignatureArkose, { saison, signatureId: linked._id, ambassadeurId: child });
    expect(await staff.query(api.competition.listSignaturesArkose, { saison })).toContainEqual({ ...linked, email: "new@example.test", statut: "a_rapprocher", liens: [] });
    expect(await staff.query(api.competition.listSignaturesArkose, { saison: "2025-26", inclureLiees: true, inclureMasquees: true })).toEqual([]);
    for (const invalidSeason of ["2026-28", "2030-31"]) await expect(staff.query(api.competition.listSignaturesArkose, { saison: invalidSeason, inclureLiees: true })).rejects.toThrow();
  });
  test("webhook Arkose : contrat NOM/Prénom, dédoublonnage et rapprochement un-à-plusieurs", async () => {
    expect(validerReponseArkose([{ NOM: " DUPONT ", Prénom: " Claire " }, { nom: "DUPONT", PRENOM: "Claire" }])).toEqual([{ nom: "DUPONT", prenom: "Claire" }]);
    expect(() => validerReponseArkose([{ NOM: "DUPONT" }])).toThrow("nom et un prénom");
    expect(() => validerReponseArkose([{ NOM: "DUPONT", nom: "MARTIN", Prénom: "Claire" }])).toThrow("plusieurs champs");
    const { t, staff, operatorId } = await setup();
    const childOne = await staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: "Enfant", prenom: "Lina" }, partenariatSigne: false });
    const childTwo = await staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: "Enfant", prenom: "Noah", dateNaissance: "2007-02-03" }, partenariatSigne: false });
    expect(await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items: [{ nom: "Parent", prenom: "Camille" }] })).toEqual({ queued: 1, autoLinked: 0, ignored: 0 });
    const pending = await staff.query(api.competition.listSignaturesArkose, { saison });
    expect(pending).toHaveLength(1);
    expect(await staff.mutation(api.competition.lierSignatureArkose, { saison, signatureId: pending[0]._id, ambassadeurIds: [childOne, childTwo] })).toEqual({ lies: 2 });
    expect(await staff.query(api.competition.listSignaturesArkose, { saison })).toEqual([]);
    expect(await staff.query(api.competition.listSignaturesArkose, { saison, inclureLiees: true })).toMatchObject([{ statut: "lie", liens: [{ ambassadeurId: childOne }, { ambassadeurId: childTwo }] }]);
    expect(await t.run((ctx) => ctx.db.get(childOne))).toMatchObject({ partenariatSigne: true });
    expect(await t.run((ctx) => ctx.db.get(childTwo))).toMatchObject({ partenariatSigne: true });
  });
  test("Arkose : plafond total de 20 liaisons après plusieurs appels, refus atomique et rejouement", async () => {
    const { t, staff, operatorId } = await setup();
    const ids: Id<"competition_ambassadeurs">[] = [];
    for (let i = 0; i < 21; i++) ids.push(await staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: `Eleve ${i}` }, partenariatSigne: false }));
    await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items: [{ nom: "Parent", prenom: "Limite" }] });
    const [signature] = await staff.query(api.competition.listSignaturesArkose, { saison });
    const args = { saison, signatureId: signature._id };
    expect(await staff.mutation(api.competition.lierSignatureArkose, { ...args, ambassadeurIds: ids.slice(0, 19) })).toEqual({ lies: 19 });
    expect(await staff.mutation(api.competition.lierSignatureArkose, { ...args, ambassadeurIds: [ids[0], ids[19]] })).toEqual({ lies: 1 });
    expect(await staff.mutation(api.competition.lierSignatureArkose, { ...args, ambassadeurIds: [ids[0]] })).toEqual({ lies: 0 });
    await expect(staff.mutation(api.competition.lierSignatureArkose, { ...args, ambassadeurIds: [ids[20]] })).rejects.toThrow("20 ambassadeurs maximum");
    expect((await staff.query(api.competition.listSignaturesArkose, { saison, inclureLiees: true }))[0].liens).toHaveLength(20);
    expect(await t.run((ctx) => ctx.db.get(ids[20]))).toMatchObject({ partenariatSigne: false, revision: 1 });
    await staff.mutation(api.competition.delierSignatureArkose, { ...args, ambassadeurId: ids[19] });
    expect(await staff.mutation(api.competition.lierSignatureArkose, { ...args, ambassadeurIds: [ids[20]] })).toEqual({ lies: 1 });
  });
  test("signature Arkose sans correspondance : masquage persistant et réaffichage", async () => {
    const { t, staff, operatorId } = await setup();
    await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items: [{ nom: "Test", prenom: "Signature" }] });
    const [signature] = await staff.query(api.competition.listSignaturesArkose, { saison });
    await staff.mutation(api.competition.masquerSignatureArkose, { saison, signatureId: signature._id });
    expect(await staff.query(api.competition.listSignaturesArkose, { saison })).toEqual([]);
    expect(await staff.query(api.competition.listSignaturesArkose, { saison, inclureMasquees: true })).toMatchObject([{ _id: signature._id, statut: "masquee" }]);
    expect(await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, { saison, userId: operatorId, items: [{ nom: "TEST", prenom: "signature" }] })).toEqual({ queued: 0, autoLinked: 0, ignored: 1 });
    await staff.mutation(api.competition.afficherSignatureArkose, { saison, signatureId: signature._id });
    expect(await staff.query(api.competition.listSignaturesArkose, { saison })).toMatchObject([{ _id: signature._id, statut: "a_rapprocher" }]);
  });

  test("webhook Arkose : une correspondance unique est automatiquement signée, les rejouements sont sans écriture", async () => {
    const { t, staff, operatorId } = await setup();
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    const args = { saison, userId: operatorId, items: [{ nom: " exemple ", prenom: "CAMILLE" }] };
    expect(await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, args)).toEqual({ queued: 0, autoLinked: 1, ignored: 0 });
    const signed = await t.run((ctx) => ctx.db.get(id));
    expect(signed).toMatchObject({ partenariatSigne: true, revision: 2 });
    expect(await t.mutation(internal.competitionArkoseWebhook.enregistrerLot, args)).toEqual({ queued: 0, autoLinked: 0, ignored: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toEqual(signed);
  });
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
    await expect(t.mutation(internal.competition.bootstrapInitialSeason, { ...args, rows: rows.map((r, i) => i === 26 ? { ...r, groupe: GROUPES[2] } : r) })).rejects.toThrow("divergentes");
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
  test("setPartenariatSigne : bascule directe, no-op, révision et isolation de saison", async () => {
    const { t, staff } = await setup();
    const id = await staff.mutation(api.competition.create, { saison, fields, partenariatSigne: false });
    const before = await t.run((ctx) => ctx.db.get(id));
    // No-op : aucune écriture si la valeur ne change pas.
    await staff.mutation(api.competition.setPartenariatSigne, { saison, id, revision: 1, partenariatSigne: false });
    expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
    // Bascule signé puis non signé, révision incrémentée à chaque écriture.
    await staff.mutation(api.competition.setPartenariatSigne, { saison, id, revision: 1, partenariatSigne: true });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ partenariatSigne: true, revision: 2, updatedBy: before!.updatedBy });
    await staff.mutation(api.competition.setPartenariatSigne, { saison, id, revision: 2, partenariatSigne: false });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ partenariatSigne: false, revision: 3 });
    // Conflit de révision et isolation de saison.
    await expect(staff.mutation(api.competition.setPartenariatSigne, { saison, id, revision: 1, partenariatSigne: true })).rejects.toThrow("Conflit");
    await expect(staff.mutation(api.competition.setPartenariatSigne, { saison: "2025-26", id, revision: 3, partenariatSigne: true })).rejects.toThrow("cette saison");
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
      await expect(denied.query(api.competition.listSignaturesArkose, { saison, inclureLiees: true, inclureMasquees: true })).rejects.toThrow();
      await expect(denied.action(api.competitionArkoseWebhook.synchroniser, { saison })).rejects.toThrow();
      await expect(denied.query(api.competition.previewImport, { saison, rows: [fields] })).rejects.toThrow();
      await expect(denied.mutation(api.competition.create, { saison, fields, partenariatSigne: false })).rejects.toThrow();
      await expect(denied.mutation(api.competition.update, { saison, id: fakeId, revision: 1, fields, partenariatSigne: true })).rejects.toThrow();
      await expect(denied.mutation(api.competition.setPartenariatSigne, { saison, id: fakeId, revision: 1, partenariatSigne: true })).rejects.toThrow();
      await expect(denied.mutation(api.competition.remove, { saison, id: fakeId, revision: 1 })).rejects.toThrow();
      await expect(denied.mutation(api.competition.importRows, { saison, plans: [] })).rejects.toThrow();
      await expect(denied.mutation(api.competition.masquerSignatureArkose, { saison, signatureId: fakeId as never })).rejects.toThrow();
      await expect(denied.mutation(api.competition.afficherSignatureArkose, { saison, signatureId: fakeId as never })).rejects.toThrow();
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
    for (const invalid of [{ ...fields, dateNaissance: "2005-02-29" }, { ...fields, nom: "" }, { ...fields, email: "a@b.test,c@d.test" }, { ...fields, groupe: "a".repeat(201) }, { ...fields, categories: "Inconnue" }]) {
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
    const plans = await staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, nom: "Nouveau" }, { ...fields, groupe: GROUPES[1] }] });
    expect(plans[1].before).toEqual({ ...fields, partenariatSigne: false });
    expect(plans[1].row.groupe).toBe(GROUPES[1]);
    await staff.mutation(api.competition.update, { saison, id, revision: 1, fields, partenariatSigne: true });
    await expect(staff.mutation(api.competition.importRows, { saison, plans })).rejects.toThrow("Conflit");
    expect((await staff.query(api.competition.list, { saison, paginationOpts })).page).toHaveLength(1);
    await expect(staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, id, revision: 1 }] })).rejects.toThrow("Conflit");
    const absent = await staff.query(api.competition.previewImport, { saison, rows: [{ ...fields, nom: "Concurrent" }] });
    await staff.mutation(api.competition.create, { saison, fields: { ...fields, nom: "Concurrent" }, partenariatSigne: false });
    await expect(staff.mutation(api.competition.importRows, { saison, plans: absent })).rejects.toThrow("Conflit");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ groupe: fields.groupe, partenariatSigne: true });
  });
});
