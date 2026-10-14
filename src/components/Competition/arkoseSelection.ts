import type { Id } from "../../../convex/_generated/dataModel";

export type AmbassadeurOption = { _id: Id<"competition_ambassadeurs">; nom: string; prenom: string; dateNaissance: string };
type AmbassadeurId = Id<"competition_ambassadeurs">;

export function selectionArkoseValide(selection: readonly AmbassadeurId[], lies: readonly AmbassadeurId[]): AmbassadeurId[] {
  return [...new Set(selection)].filter((id) => !lies.includes(id)).slice(0, Math.max(0, 20 - lies.length));
}

export function optionsArkose(ambassadeurs: readonly AmbassadeurOption[], selection: readonly AmbassadeurId[], lies: readonly AmbassadeurId[], search: string): AmbassadeurOption[] {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const terms = normalize(search).split(/\s+/).filter(Boolean);
  const excluded = new Set([...selection, ...lies]);
  return ambassadeurs.filter((option) => !excluded.has(option._id) && terms.every((term) => normalize(`${option.prenom} ${option.nom}`).includes(term)));
}
