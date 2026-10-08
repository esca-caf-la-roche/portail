import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { chargerToutesLesFiches, COLONNES, dateExcel, genererCsv, lignesExport, lireLignesCsv, lireLignesExcel, parserCsv } from "./competitionExcel";

const base = ["Exemple", "Camille", "2005-02-03", "Homme", "Compétiteur", "Groupe Perf.", "camille@example.test"];
const doc: Doc<"competition_ambassadeurs"> = {
  _id: "fake-id" as Id<"competition_ambassadeurs">, _creationTime: 0, saison: "2026-27",
  nom: "=nom", prenom: "Camille", dateNaissance: "2005-02-03", civilite: "Homme", categories: "Compétiteur", groupe: "Groupe Perf.", email: "camille@example.test", cleIdentite: "test", partenariatSigne: true, revision: 2, updatedAt: 0, updatedBy: "user" as Id<"users">,
};

describe("CSV compétition", () => {
  test.each([51, 200])("export saison entier %i lignes sans troncature, CSV réimportable", async (count) => {
    const all = Array.from({ length: count }, (_, i) => ({ ...doc, nom: `Exemple ${i}` }));
    const rows = await chargerToutesLesFiches(async (cursor) => {
      const start = Number(cursor ?? 0);
      return { page: all.slice(start, start + 50), isDone: start + 50 >= count, continueCursor: String(start + 50) };
    });
    expect(rows).toEqual(all);
    expect(lignesExport(rows)).toHaveLength(count + 1);
    expect(lireLignesCsv(genererCsv(rows), "2026-27")).toHaveLength(count);
  });
  test.each([201, 2000])("export saison entier %i lignes en un CSV, réimport API plafonné à 200", async (count) => {
    const all = Array.from({ length: count }, (_, i) => ({ ...doc, nom: `Exemple ${i}` }));
    const rows = await chargerToutesLesFiches(async (cursor) => {
      const start = Number(cursor ?? 0);
      return { page: all.slice(start, start + 50), isDone: start + 50 >= count, continueCursor: String(start + 50) };
    });
    const csv = genererCsv(rows);
    expect(parserCsv(csv)).toHaveLength(count + 1); // toutes les fiches exportées
    expect(() => lireLignesCsv(csv, "2026-27")).toThrow("200"); // l'import API reste borné à 200
  });
  test("export refuse 2001 et pagination bloquée sans fichier partiel", async () => {
    await expect(chargerToutesLesFiches(async () => ({ page: Array(2001).fill(doc), isDone: true, continueCursor: "" }))).rejects.toThrow("2000");
    await expect(chargerToutesLesFiches(async () => ({ page: [], isDone: false, continueCursor: "same" }))).rejects.toThrow("Pagination");
    await expect(chargerToutesLesFiches(async () => ({ page: Array(2001).fill(doc), isDone: true, continueCursor: "" }))).rejects.toThrow("Aucun fichier partiel");
  });
  test("conserve colonne vide, absence de signature et accents des colonnes", () => {
    const rows = lireLignesExcel([[...COLONNES], base], "2026-27");
    expect(rows[0]).toMatchObject({ nom: "Exemple", dateNaissance: "2005-02-03", civilite: "Homme", categories: "Compétiteur" });
    expect(rows[0].partenariatSigne).toBeUndefined();
  });
  test("accepte et ignore l'ancienne colonne « Colonne 1 »", () => {
    const rows = lireLignesExcel([[...COLONNES, "Colonne 1"], [...base, "ignorée"]], "2026-27");
    expect(rows[0]).toMatchObject({ nom: "Exemple", categories: "Compétiteur" });
    expect(rows[0]).not.toHaveProperty("colonne1");
    expect(() => lireLignesExcel([[...COLONNES], ["Exemple", "Camille", "2005-02-03", "Homme", "Inconnue", "Groupe Perf.", "camille@example.test"]], "2026-27")).toThrow("Catégorie");
  });
  test("roundtrip CSV réimportable avec ID, révision, saison et signature", () => {
    const csv = genererCsv([doc]);
    // La formule est neutralisée à l'écriture (Excel ne l'exécute pas)…
    expect(csv).toContain("'=nom");
    const rows = lireLignesCsv(csv, "2026-27");
    expect(rows[0]).toMatchObject({ id: doc._id, revision: 2, saison: "2026-27", partenariatSigne: true, nom: "=nom", categories: "Compétiteur" });
    expect(() => lireLignesCsv(csv, "2025-26")).toThrow("saison");
  });
  test("CSV : guillemets, point-virgule et saut de ligne encadrés puis restaurés", () => {
    const special = { ...doc, nom: 'Nom; avec "guillemets"', prenom: "=2+2", email: "" };
    const rows = lireLignesCsv(genererCsv([special]), "2026-27");
    expect(rows[0]).toMatchObject({ nom: 'Nom; avec "guillemets"', prenom: "=2+2", email: "" });
  });
  test("dates UTC, françaises, ISO, bissextiles et ambiguïtés", () => {
    expect(dateExcel(new Date("2004-02-29T00:00:00Z"))).toBe("2004-02-29");
    expect(dateExcel("29/02/2004")).toBe("2004-02-29");
    expect(dateExcel("2004-02-29")).toBe("2004-02-29");
    for (const value of ["29/02/2005", "2004-13-01", "2004-02-30", "03/04/05", 40000, null, new Date("invalid")]) expect(() => dateExcel(value)).toThrow();
  });
  test("refuse colonnes manquantes/inconnues/dupliquées, signatures vides et doublons", () => {
    expect(() => lireLignesExcel([["Nom"], ["X"]], "2026-27")).toThrow("Colonne obligatoire");
    expect(() => lireLignesExcel([[...COLONNES, "Inconnue"], base], "2026-27")).toThrow("Colonnes inconnues");
    expect(() => lireLignesExcel([[...COLONNES, "Nom"], base], "2026-27")).toThrow("dupliquées");
    expect(() => lireLignesExcel([[...COLONNES, "Partenariat signé"], [...base, ""]], "2026-27")).toThrow("Oui ou Non");
    expect(() => lireLignesExcel([[...COLONNES], base, base], "2026-27")).toThrow("dupliquée");
    expect(() => lireLignesExcel([[...COLONNES, "Identifiant"], [...base, "id"]], "2026-27")).toThrow("conserver");
    expect(() => lireLignesExcel([[...COLONNES], ...Array(201).fill(base)], "2026-27")).toThrow("200");
  });
});
