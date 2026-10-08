// @vitest-environment node
import { expect, test } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import readXlsxFile from "read-excel-file/node";
import { COLONNES, META_COLONNES, lireLignesExcel } from "./competitionExcel";

test("vrai XLSX en mémoire (import) : accents, cellule date réelle, texte formule, ID et révision", async () => {
  const headers = [...COLONNES, ...META_COLONNES];
  const cells = [
    { type: String, value: "=Éléonore" },
    { type: String, value: "Rémi" },
    { type: Date, value: new Date("2004-02-29T00:00:00Z"), format: "dd/mm/yyyy" },
    { type: String, value: "Femme" },
    { type: String, value: "Compétiteur" },
    { type: String, value: "Groupe Perf." },
    { type: String, value: "remi@example.test" },
    { type: String, value: "Non" },
    { type: String, value: "2026-27" },
    { type: String, value: "fake-id" },
    { type: Number, value: 7 },
  ];
  const buffer = await writeXlsxFile([headers.map((value) => ({ type: String, value })), cells]).toBuffer();
  const sheets = await readXlsxFile(buffer);
  const matrix = sheets[0].data.map((row) => row.map((cell) => {
    if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell instanceof Date) return cell;
    throw new Error("Unexpected cell type");
  }));
  const rows = lireLignesExcel(matrix, "2026-27");
  expect(rows[0]).toMatchObject({ nom: "=Éléonore", prenom: "Rémi", dateNaissance: "2004-02-29", civilite: "Femme", categories: "Compétiteur", groupe: "Groupe Perf.", email: "remi@example.test", partenariatSigne: false, saison: "2026-27", revision: 7 });
});