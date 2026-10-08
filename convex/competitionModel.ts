import { ConvexError, v, type Infer } from "convex/values";

export const MAX_IMPORT = 200;

// Valeurs métier autorisées des colonnes typées. Source unique de vérité : ces
// listes alimentent à la fois la validation serveur (`nettoyerChamps`) et les
// `<select>` du front. Aucune valeur libre n'est acceptée sur ces colonnes ;
// ajouter une valeur exige de la déclarer ici puis de redéployer.
export const CIVILITES = ["Homme", "Femme"] as const;
export const CATEGORIES = ["Compétiteur", "Coach"] as const;
export const GROUPES = [
  "Compétition 1 : Découvrir la compétition",
  "Compétition 2 : Vers un niveau national",
  "Groupe Compétition (sans cours)",
  "Groupe Perf.",
] as const;
export type Civilite = (typeof CIVILITES)[number];
export type Categorie = (typeof CATEGORIES)[number];
export type Groupe = (typeof GROUPES)[number];

export const ambassadeurFields = v.object({
  nom: v.string(), prenom: v.string(), dateNaissance: v.string(),
  civilite: v.string(), categories: v.string(), groupe: v.string(),
  email: v.string(),
});
export type AmbassadeurFields = Infer<typeof ambassadeurFields>;
export const importRowValidator = ambassadeurFields.extend({
  partenariatSigne: v.optional(v.boolean()),
  id: v.optional(v.id("competition_ambassadeurs")),
  revision: v.optional(v.number()),
  saison: v.optional(v.string()),
});
export type ImportRow = Infer<typeof importRowValidator>;
export const ambassadeurValidator = ambassadeurFields.extend({
  _id: v.id("competition_ambassadeurs"), _creationTime: v.number(),
  saison: v.string(), cleIdentite: v.string(), partenariatSigne: v.boolean(),
  revision: v.number(), updatedAt: v.number(), updatedBy: v.optional(v.id("users")),
  updatedSource: v.optional(v.literal("bootstrap")),
});
export const planValidator = v.object({
  row: importRowValidator,
  existingId: v.union(v.id("competition_ambassadeurs"), v.null()),
  revision: v.union(v.number(), v.null()),
  action: v.union(v.literal("creation"), v.literal("modification"), v.literal("identique")),
  before: v.union(ambassadeurFields.extend({ partenariatSigne: v.boolean() }), v.null()),
});

export function normaliserTexte(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function dateValide(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "2100-12-31";
}

// Une colonne typée vide reste autorisée (valeur non renseignée) ; seule une
// valeur non vide et hors liste est refusée.
function verifierValeur(label: string, valeur: string, autorisees: readonly string[]): void {
  if (valeur !== "" && !autorisees.includes(valeur)) {
    throw new ConvexError(`${label} non autorisée : « ${valeur} ».`);
  }
}

export function nettoyerChamps(input: AmbassadeurFields): AmbassadeurFields {
  const result: AmbassadeurFields = {
    nom: input.nom, prenom: input.prenom, dateNaissance: input.dateNaissance,
    civilite: input.civilite, categories: input.categories, groupe: input.groupe,
    email: input.email,
  };
  for (const key of Object.keys(result) as (keyof AmbassadeurFields)[]) {
    result[key] = result[key].trim();
    const max = key === "email" ? 254 : key === "dateNaissance" ? 10 : 200;
    if (result[key].length > max || Array.from(result[key]).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new ConvexError("Un champ est trop long ou contient un caractère interdit.");
    }
  }
  if (!result.nom || !result.prenom) throw new ConvexError("Nom et prénom obligatoires.");
  if (!dateValide(result.dateNaissance)) throw new ConvexError("Date de naissance invalide (AAAA-MM-JJ, 1900–2100).");
  if (result.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(result.email)) throw new ConvexError("Adresse email invalide.");
  verifierValeur("Civilité", result.civilite, CIVILITES);
  verifierValeur("Catégorie", result.categories, CATEGORIES);
  verifierValeur("Groupe", result.groupe, GROUPES);
  return result;
}

export function cleIdentite(champs: AmbassadeurFields): string {
  return JSON.stringify([normaliserTexte(champs.nom), normaliserTexte(champs.prenom), champs.dateNaissance]);
}

export function verifierRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConvexError("Révision invalide.");
}
