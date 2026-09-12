export const DELAI_REVERIFICATION_SYNC_PAIEMENTS_MS = 4 * 60 * 60_000;

export function routePaiements(pathname: string): {
  surValidation: boolean;
  surIndexTraites: boolean;
} {
  return {
    surValidation: /^\/paiements\/?$/.test(pathname),
    surIndexTraites: /^\/paiements\/(approbations|attente)\/?$/.test(pathname),
  };
}

export function synchronisationPaiementsEnCours(
  surValidation: boolean,
  autoSyncTerminee: boolean,
  syncManuelleEnCours: boolean,
): boolean {
  return syncManuelleEnCours || (surValidation && !autoSyncTerminee);
}
