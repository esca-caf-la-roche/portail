import readXlsxFile from "read-excel-file/node";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Préparation hors réseau uniquement. Le fichier de sortie contient des données
// personnelles : chemin hors dépôt obligatoire, suppression après import.
const [input, output] = process.argv.slice(2);
const headers = ["Nom", "Prénom", "Date de naissance", "Civilité", "Catégories", "Colonne 1", "Quels groupe", "Email"];
const keys = ["nom", "prenom", "dateNaissance", "civilite", "categories", "colonne1", "groupe", "email"];
try {
  if (!input || !output || process.argv.length !== 4) throw new Error();
  const target = resolve(output);
  const repository = resolve(import.meta.dirname, "..");
  if (target.toLowerCase().startsWith(`${repository.toLowerCase()}\\`) || target.startsWith(`${repository}/`)) throw new Error();
  if (!/\.xlsx$/i.test(input) || (await stat(input)).size > 2 * 1024 * 1024) throw new Error();
  const sheets = (await readXlsxFile(input, { trim: false })).filter((s) => s.data.length);
  if (sheets.length !== 1) throw new Error();
  const [header, ...data] = sheets[0].data;
  if (header.length !== 8 || header.some((h, i) => h !== headers[i])) throw new Error();
  const source = data.filter((r) => r.some((c) => c !== null && c !== ""));
  if (source.length !== 29) throw new Error();
  const identities = new Map();
  const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rows = [];
  for (const cells of source) {
    if (cells.length > 8) throw new Error();
    const values = keys.map((key, i) => {
      const cell = cells[i];
      if (key !== "dateNaissance") {
        if (cell == null) return "";
        if (typeof cell !== "string") throw new Error();
        return cell.trim();
      }
      const text = cell instanceof Date ? cell.toISOString().slice(0, 10) : typeof cell === "string" ? cell.trim().replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1") : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) throw new Error();
      return text;
    });
    const identity = JSON.stringify([normalize(values[0]), normalize(values[1]), values[2]]);
    // Comparer les huit cellules SOURCE, avant trim : jamais fusionner une
    // identité portant une différence de coordonnées ou de champ métier.
    const fingerprint = JSON.stringify(Array.from({ length: 8 }, (_, i) => cells[i] ?? null));
    if (identities.has(identity)) {
      if (identities.get(identity) !== fingerprint) throw new Error();
      continue;
    }
    identities.set(identity, fingerprint);
    rows.push({ ...Object.fromEntries(keys.map((key, i) => [key, values[i]])), saison: "2026-27", partenariatSigne: false });
  }
  if (rows.length !== 27) throw new Error();
  await writeFile(target, JSON.stringify({ saison: "2026-27", rows }), { flag: "wx", mode: 0o600 });
  console.log("Payload préparé : 29 lignes source, 27 fiches uniques, 2 doublons identiques retirés, saison 2026-27, signatures non. Aucun appel réseau.");
} catch {
  // Ne jamais afficher les erreurs du parseur (cellules, chemins) ou le payload.
  console.error("Préparation refusée. Vérifier arguments, XLSX de 29 lignes / 27 identités sans divergence et destination hors dépôt non existante.");
  process.exitCode = 1;
}
