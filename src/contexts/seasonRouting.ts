export type SaisonDisponible = {
  nom: string;
  isDefault?: boolean;
};

const MODULES_SAISONNIERS = [
  "/compta",
  "/budget",
  "/gestion-samedis",
  "/gestion-planning-salaries-samedis",
  "/samedis",
  "/planning-salaries-samedis",
] as const;

export function moduleSaisonnier(pathname: string): string | null {
  return MODULES_SAISONNIERS.find(
    (prefixe) => pathname === prefixe || pathname.startsWith(`${prefixe}/`),
  ) ?? null;
}

export function saisonParDefaut(
  saisons: readonly SaisonDisponible[] | undefined,
): string | null {
  return saisons?.find((saison) => saison.isDefault)?.nom ?? null;
}
