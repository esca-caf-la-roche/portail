import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { cleIdentite, dateValide, MAX_IMPORT, nettoyerChamps, normaliserTexte, verifierRevision, type ImportRow } from "../../convex/competitionModel";

export const COLONNES = ["Nom", "Prénom", "Date de naissance", "Civilité", "Catégories", "Quels groupe", "Email"] as const;
export const META_COLONNES = ["Partenariat signé", "Saison", "Identifiant", "Révision"] as const;
// Colonne historique supprimée : acceptée à l'import mais ignorée, pour rester
// compatible avec les anciens exports encore détenus par les utilisateurs.
export const COLONNES_HISTORIQUES = ["Colonne 1"] as const;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT = 2000;
// Point-virgule : c'est le séparateur qu'Excel francophone attend nativement pour
// un `.csv`. Une virgule y laisserait tout le contenu dans une seule colonne.
export const SEPARATEUR_CSV = ";";
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
  const accepted = [...COLONNES, ...META_COLONNES, ...COLONNES_HISTORIQUES].map(normaliserTexte);
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
      const fields = nettoyerChamps({ nom: texte(get("Nom")), prenom: texte(get("Prénom")), dateNaissance: dateExcel(get("Date de naissance") ?? null), civilite: texte(get("Civilité")), categories: texte(get("Catégories")), groupe: texte(get("Quels groupe")), email: texte(get("Email")) });
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

/**
 * Neutralise l'injection de formule : une cellule commençant par `=`, `+`, `-`,
 * `@`, une tabulation ou un retour est préfixée d'une apostrophe, retirée à la
 * réimportation. Un CSV n'a pas de type de cellule : sans cette précaution,
 * Excel exécuterait la formule à l'ouverture d'un fichier pourtant inoffensif
 * à l'import.
 */
function neutraliserFormule(valeur: string): string {
  return /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
}

function restaurerFormule(valeur: string): string {
  return /^'[=+\-@\t\r]/.test(valeur) ? valeur.slice(1) : valeur;
}

function celluleCsv(valeur: string): string {
  const neutralisee = neutraliserFormule(valeur);
  return /[";\r\n]/.test(neutralisee) ? `"${neutralisee.replace(/"/g, '""')}"` : neutralisee;
}

/**
 * Matrice texte canonique (en-têtes, puis fiches) partagée par l'export CSV.
 * Toutes les cellules sont explicitement textuelles : aucune formule exécutable.
 */
export function lignesExport(rows: readonly Doc<"competition_ambassadeurs">[]): string[][] {
  if (rows.length > MAX_EXPORT) throw new Error("Export refusé : saison supérieure à 2000 fiches. Aucun fichier partiel généré.");
  return [[...COLONNES, ...META_COLONNES], ...rows.map((r) => [r.nom, r.prenom, r.dateNaissance, r.civilite, r.categories, r.groupe, r.email, r.partenariatSigne ? "Oui" : "Non", r.saison, r._id, String(r.revision)])];
}

/** CSV complet de la saison : BOM UTF-8 (accents Excel) et séparateur point-virgule. */
export function genererCsv(rows: readonly Doc<"competition_ambassadeurs">[]): string {
  const lignes = lignesExport(rows).map((ligne) => ligne.map(celluleCsv).join(SEPARATEUR_CSV));
  return `\uFEFF${lignes.join("\r\n")}\r\n`;
}

function detecterSeparateur(texte: string): string {
  const premiere = texte.split(/\r?\n/, 1)[0] ?? "";
  return (premiere.match(/;/g)?.length ?? 0) >= (premiere.match(/,/g)?.length ?? 0) ? ";" : ",";
}

/** Parseur CSV RFC 4180 minimal : guillemets, `""` échappé, sauts de ligne internes. */
export function parserCsv(texte: string): string[][] {
  const source = texte.replace(/^\uFEFF/, "");
  const separateur = detecterSeparateur(source);
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let champ = "";
  let guillemets = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (guillemets) {
      if (c === '"') {
        if (source[i + 1] === '"') { champ += '"'; i++; }
        else guillemets = false;
      } else champ += c;
      continue;
    }
    if (c === '"') guillemets = true;
    else if (c === separateur) { ligne.push(champ); champ = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      ligne.push(champ); champ = "";
      lignes.push(ligne); ligne = [];
    } else champ += c;
  }
  if (champ !== "" || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  return lignes;
}

export function lireLignesCsv(texte: string, saison: string): ImportRow[] {
  return lireLignesExcel(parserCsv(texte).map((ligne) => ligne.map(restaurerFormule)), saison);
}

export function exporterCompetitionCsv(rows: readonly Doc<"competition_ambassadeurs">[], saison: string) {
  const blob = new Blob([genererCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const lien = document.createElement("a");
  lien.href = url;
  lien.download = `ambassadeurs-arkose-${saison}.csv`;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  // Révocation différée : Firefox/Safari annulent le téléchargement si l'URL est
  // révoquée dans le même tick que le clic.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Chargement ponctuel borné de toute la saison, jamais un abonnement à la saison entière. */
export async function chargerToutesLesFiches<T>(fetchPage: (cursor: string | null) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>): Promise<T[]> {
  const rows: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let calls = 0; calls < 100; calls++) {
    const result = await fetchPage(cursor);
    rows.push(...result.page);
    if (rows.length > MAX_EXPORT) throw new Error("Export refusé : saison supérieure à 2000 fiches. Aucun fichier partiel généré.");
    if (result.isDone) return rows;
    if (!result.continueCursor || cursors.has(result.continueCursor)) throw new Error("Pagination interrompue. Aucun export partiel.");
    cursors.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new Error("Export refusé : limite de 100 pages atteinte. Aucun export partiel.");
}

export async function lireFichierCompetition(file: File, saison: string): Promise<ImportRow[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Fichier limité à 2 Mo.");
  if (/\.csv$/i.test(file.name)) return lireLignesCsv(await file.text(), saison);
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Sélectionnez un fichier .xlsx ou .csv.");
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
