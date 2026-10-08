import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { cleIdentite, dateValide, MAX_IMPORT, nettoyerChamps, normaliserTexte, verifierRevision, type ImportRow } from "../../convex/competitionModel";

export const COLONNES = ["Nom", "Prénom", "Date de naissance", "Civilité", "Catégories", "Colonne 1", "Quels groupe", "Email"] as const;
export const META_COLONNES = ["Partenariat signé", "Saison", "Identifiant", "Révision"] as const;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT = 2000;
type Cell = string | number | boolean | Date | null;

export function erreurCompetition(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  if (error instanceof Error && !error.message.startsWith("[CONVEX")) return error.message;
  return "L’opération a échoué. Vérifiez vos accès et réessayez.";
}

export function dateExcel(value: Cell): string {
  let result: string;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Date Excel invalide.");
    result = value.toISOString().slice(0, 10);
  } else if (typeof value === "string") {
    const text = value.trim();
    const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    result = french ? `${french[3]}-${french[2]}-${french[1]}` : text;
  } else {
    // Une cellule numérique sans format date est ambiguë : ne jamais deviner.
    throw new Error("Date attendue au format AAAA-MM-JJ, JJ/MM/AAAA ou cellule Excel date.");
  }
  if (!dateValide(result)) throw new Error("Date de naissance invalide.");
  return result;
}

function texte(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("Une colonne texte contient une valeur non textuelle.");
  return value;
}

export function lireLignesExcel(data: Cell[][], saison: string): ImportRow[] {
  if (data.length > MAX_IMPORT + 1) throw new Error("Fichier limité à 200 lignes de données.");
  const headers = (data[0] ?? []).map((cell) => normaliserTexte(texte(cell)));
  const accepted = [...COLONNES, ...META_COLONNES].map(normaliserTexte);
  if (headers.length > accepted.length || headers.some((h) => !accepted.includes(h)) || new Set(headers).size !== headers.length) throw new Error("Colonnes inconnues ou dupliquées.");
  for (const header of COLONNES) if (!headers.includes(normaliserTexte(header))) throw new Error(`Colonne obligatoire absente : ${header}.`);
  const index = (header: string) => headers.indexOf(normaliserTexte(header));
  const hasId = index("Identifiant") >= 0;
  if (hasId !== (index("Révision") >= 0) || (hasId && index("Saison") < 0)) throw new Error("Un export doit conserver Identifiant, Révision et Saison.");
  const rows: ImportRow[] = [];
  const keys = new Set<string>();
  for (const [offset, cells] of data.slice(1).entries()) {
    if (cells.every((cell) => cell === null || cell === "")) continue;
    try {
      if (cells.length > headers.length) throw new Error("Données sans en-tête.");
      const get = (header: string) => cells[index(header)];
      const fields = nettoyerChamps({ nom: texte(get("Nom")), prenom: texte(get("Prénom")), dateNaissance: dateExcel(get("Date de naissance") ?? null), civilite: texte(get("Civilité")), categories: texte(get("Catégories")), colonne1: texte(get("Colonne 1")), groupe: texte(get("Quels groupe")), email: texte(get("Email")) });
      const row: ImportRow = { ...fields };
      if (index("Saison") >= 0) {
        row.saison = texte(get("Saison")).trim();
        if (row.saison !== saison) throw new Error("La saison du fichier ne correspond pas à la saison sélectionnée.");
      }
      if (index("Partenariat signé") >= 0) {
        const raw = get("Partenariat signé");
        const text = typeof raw === "boolean" ? (raw ? "oui" : "non") : normaliserTexte(texte(raw));
        if (!["oui", "non"].includes(text)) throw new Error("Partenariat signé doit être Oui ou Non (aucune case vide).");
        row.partenariatSigne = text === "oui";
      }
      if (hasId) {
        const id = texte(get("Identifiant")).trim();
        const rawRevision = get("Révision");
        const revision = typeof rawRevision === "number" ? rawRevision : Number(texte(rawRevision));
        if (!id) throw new Error("Identifiant exporté manquant.");
        verifierRevision(revision);
        row.id = id as Id<"competition_ambassadeurs">;
        row.revision = revision;
      }
      const key = cleIdentite(fields);
      if (keys.has(key)) throw new Error("Identité dupliquée dans le fichier.");
      keys.add(key);
      rows.push(row);
    } catch (error) {
      throw new Error(`Ligne ${offset + 2} : ${erreurCompetition(error)}`, { cause: error });
    }
  }
  if (!rows.length) throw new Error("Aucune ligne à importer.");
  return rows;
}

/** Toutes les cellules sont des chaînes explicites : aucune formule Excel exécutée. */
export function lignesExportExcel(rows: readonly Doc<"competition_ambassadeurs">[]): string[][] {
  if (rows.length > MAX_IMPORT) throw new Error("Export réimportable limité à 200 fiches. Filtrez ou exportez par pages.");
  return [[...COLONNES, ...META_COLONNES], ...rows.map((r) => [r.nom, r.prenom, r.dateNaissance, r.civilite, r.categories, r.colonne1, r.groupe, r.email, r.partenariatSigne ? "Oui" : "Non", r.saison, r._id, String(r.revision)])];
}

/** Chargement ponctuel borné, jamais un abonnement à la saison entière. */
export async function chargerExportSaison<T>(fetchPage: (cursor: string | null) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>): Promise<T[][]> {
  const rows: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let calls = 0; calls < 100; calls++) {
    const result = await fetchPage(cursor);
    rows.push(...result.page);
    if (rows.length > MAX_EXPORT) throw new Error("Export refusé : saison supérieure à 2000 fiches. Aucun fichier partiel généré.");
    if (result.isDone) {
      const batches: T[][] = [];
      for (let i = 0; i < rows.length; i += MAX_IMPORT) batches.push(rows.slice(i, i + MAX_IMPORT));
      return batches;
    }
    if (!result.continueCursor || cursors.has(result.continueCursor)) throw new Error("Pagination interrompue. Aucun export partiel.");
    cursors.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new Error("Export refusé : limite de 100 pages atteinte. Aucun export partiel.");
}

export async function lireFichierCompetition(file: File, saison: string): Promise<ImportRow[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Fichier limité à 2 Mo.");
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Sélectionnez un fichier .xlsx.");
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const sheets = await readXlsxFile(file);
  const filled = sheets.filter((s) => s.data.length > 0);
  if (filled.length !== 1) throw new Error("Le classeur doit contenir une seule feuille non vide.");
  const data = filled[0].data.map((row) => row.map((cell): Cell => {
    if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell instanceof Date) return cell;
    throw new Error("Type de cellule Excel non pris en charge.");
  }));
  return lireLignesExcel(data, saison);
}

export async function exporterCompetition(rows: readonly Doc<"competition_ambassadeurs">[], saison: string, suffix = "") {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const cells = lignesExportExcel(rows).map((r) => r.map((value) => ({ type: String, value })));
  await writeXlsxFile(cells).toFile(`ambassadeurs-arkose-${saison}${suffix}.xlsx`);
}
