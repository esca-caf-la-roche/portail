// @vitest-environment node
import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import writeXlsxFile from "write-excel-file/node";
import { COLONNES } from "./competitionExcel";

test("CLI source29 : deux doublons exacts donnent27 ; divergence et mauvais comptes refusés", async () => {
  const dir = await mkdtemp(join(tmpdir(), "competition-cli-"));
  const rows = Array.from({ length: 29 }, (_, i) => [`Fictif ${i}`, "Émilie", "03/02/2005", "Mme", "Élite", "colonne conservée", "Groupe été", "test@example.test"]);
  rows[7] = [...rows[4]]; // Lignes Excel 6 et 9.
  rows[27] = [...rows[6]]; // Lignes Excel 8 et 29.
  async function run(data: string[][], name: string) {
    const xlsx = join(dir, `${name}.xlsx`);
    const output = join(dir, `${name}.json`);
    await writeXlsxFile([[...COLONNES], ...data].map((r) => r.map((value) => ({ type: String, value })))).toFile(xlsx);
    const result = spawnSync(process.execPath, ["scripts/competition-bootstrap.mjs", xlsx, output], { encoding: "utf8" });
    return { result, output };
  }
  try {
    const { result, output } = await run(rows, "valid");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Émilie");
    const payload = JSON.parse(await readFile(output, "utf8"));
    expect(payload).not.toHaveProperty("operatorId");
    expect(payload.rows).toHaveLength(27);
    expect(payload.rows[0]).toEqual({ nom: rows[0][0], prenom: "Émilie", dateNaissance: "2005-02-03", civilite: "Mme", categories: "Élite", colonne1: "colonne conservée", groupe: "Groupe été", email: "test@example.test", saison: "2026-27", partenariatSigne: false });
    for (const [index, bad] of [rows.slice(1), [...rows, [...rows[0]]], rows.map((r, i) => i === 28 ? [...rows[0]] : r), rows.map((r, i) => i === 27 ? [...r.map((v, j) => j === 0 ? "Extra unique" : v)] : r), rows.map((r, i) => i === 7 ? r.map((v, j) => j === 7 ? "other@example.test" : v) : r), rows.map((r, i) => i === 7 ? r.map((v, j) => j === 0 ? `${v} ` : v) : r)].entries()) {
      const failure = await run(bad, `invalid-${index}`);
      expect(failure.result.status).toBe(1);
      expect(failure.result.stderr).not.toContain("example.test");
      await expect(readFile(failure.output)).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }); // Uniquement le dossier créé par ce test.
  }
});
