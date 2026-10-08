// @vitest-environment node
import { expect, test } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import readXlsxFile from "read-excel-file/node";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { dateExcel, lignesExportExcel, lireLignesExcel } from "./competitionExcel";

test("vrai XLSX en mémoire : accents, vides, texte formule, dates, ID et révision", async () => {
  const doc: Doc<"competition_ambassadeurs"> = {
    _id: "fake-id" as Id<"competition_ambassadeurs">, _creationTime: 0, saison: "2026-27",
    nom: "=Éléonore", prenom: "Rémi", dateNaissance: "2004-02-29", civilite: "Femme", categories: "Compétiteur", groupe: "Groupe Perf.", email: "remi@example.test",
    cleIdentite: "test", partenariatSigne: false, revision: 7, updatedAt: 0, updatedSource: "bootstrap",
  };
  const buffer = await writeXlsxFile(lignesExportExcel([doc]).map((r) => r.map((value) => ({ type: String, value })))).toBuffer();
  const sheets = await readXlsxFile(buffer);
  const matrix = sheets[0].data.map((row) => row.map((cell) => {
    if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell instanceof Date) return cell;
    throw new Error("Unexpected cell type");
  }));
  const rows = lireLignesExcel(matrix, "2026-27");
  expect(rows[0]).toMatchObject({ nom: "=Éléonore", prenom: "Rémi", civilite: "Femme", categories: "Compétiteur", groupe: "Groupe Perf.", email: doc.email, dateNaissance: "2004-02-29", id: doc._id, revision: 7, saison: "2026-27", partenariatSigne: false });
  const dateBuffer = await writeXlsxFile([[{ type: Date, value: new Date("2004-02-29T00:00:00Z"), format: "dd/mm/yyyy" }]]).toBuffer();
  const dateCell = (await readXlsxFile(dateBuffer))[0].data[0][0];
  expect(dateCell).toBeInstanceOf(Date);
  if (!(dateCell instanceof Date)) throw new Error("Expected actual Excel date");
  expect(dateExcel(dateCell)).toBe("2004-02-29");
});
