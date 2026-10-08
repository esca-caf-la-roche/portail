import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { chargerExportSaison, COLONNES, dateExcel, lignesExportExcel, lireLignesExcel } from "./competitionExcel";

const base = ["Exemple", "Camille", "2005-02-03", "Homme", "Compétiteur", "Groupe Perf.", "camille@example.test"];
const doc: Doc<"competition_ambassadeurs"> = {
  _id: "fake-id" as Id<"competition_ambassadeurs">, _creationTime: 0, saison: "2026-27",
  nom: "=nom", prenom: "Camille", dateNaissance: "2005-02-03", civilite: "Homme", categories: "Compétiteur", groupe: "Groupe Perf.", email: "camille@example.test", cleIdentite: "test", partenariatSigne: true, revision: 2, updatedAt: 0, updatedBy: "user" as Id<"users">,
};

describe("XLSX compétition", () => {
  test.each([51, 200, 201, 2000])("export saison entier %i lignes sans troncature, lots réimportables", async (count) => {
    const all = Array.from({ length: count }, (_, i) => ({ ...doc, nom: `Exemple ${i}` }));
    const batches = await chargerExportSaison(async (cursor) => {
      const start = Number(cursor ?? 0);
      return { page: all.slice(start, start + 50), isDone: start + 50 >= count, continueCursor: String(start + 50) };
    });
    expect(batches.flat()).toEqual(all);
    expect(batches.every((b) => b.length <= 200)).toBe(true);
    expect(batches.flatMap((b) => lireLignesExcel(lignesExportExcel(b), "2026-27"))).toHaveLength(count);
  });
  test("export refuse 2001 et pagination bloquée sans lot partiel", async () => {
    await expect(chargerExportSaison(async () => ({ page: Array(2001).fill(doc), isDone: true, continueCursor: "" }))).rejects.toThrow("2000");
    await expect(chargerExportSaison(async () => ({ page: [], isDone: false, continueCursor: "same" }))).rejects.toThrow("Pagination");
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
  test("roundtrip export réimportable avec ID, révision, saison et signature", () => {
    const matrix = lignesExportExcel([doc]);
    expect(matrix[1][0]).toBe("=nom");
    const rows = lireLignesExcel(matrix, "2026-27");
    expect(rows[0]).toMatchObject({ id: doc._id, revision: 2, saison: "2026-27", partenariatSigne: true, nom: "=nom", categories: "Compétiteur" });
    expect(() => lireLignesExcel(matrix, "2025-26")).toThrow("saison");
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
