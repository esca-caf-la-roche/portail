export type SyncSource = "helloasso" | "scrap" | "annuaire" | "eleves";

const SYNC_INTERVAL_MS = (Number(process.env.SYNC_TTL_MINUTES) || 60) * 60_000;
export const MANUAL_SYNC_INTERVAL_MS = 5 * 60_000;
export const ANNUAIRE_SYNC_INTERVAL_MS = 12 * 60 * 60_000;

export const SYNC_SUCCESS_KEYS: Record<SyncSource, string> = {
  helloasso: "last_sync_helloasso",
  scrap: "last_sync_scrap",
  annuaire: "last_sync_annuaire",
  eleves: "last_sync_eleves",
};

export const AUTOMATIC_SYNC_INTERVALS_MS: Record<SyncSource, number> = {
  helloasso: SYNC_INTERVAL_MS,
  scrap: SYNC_INTERVAL_MS,
  annuaire: ANNUAIRE_SYNC_INTERVAL_MS,
  eleves: SYNC_INTERVAL_MS,
};

export const MANUAL_SYNC_LOCK_KEYS: Record<SyncSource, string> = {
  helloasso: "last_manual_sync_paiements_abo",
  scrap: SYNC_SUCCESS_KEYS.scrap,
  annuaire: SYNC_SUCCESS_KEYS.annuaire,
  eleves: SYNC_SUCCESS_KEYS.scrap,
};

export const MANUAL_SYNC_INTERVALS_MS: Record<SyncSource, number> = {
  helloasso: MANUAL_SYNC_INTERVAL_MS,
  scrap: MANUAL_SYNC_INTERVAL_MS,
  annuaire: ANNUAIRE_SYNC_INTERVAL_MS,
  eleves: MANUAL_SYNC_INTERVAL_MS,
};

// L'annuaire est transversal et volontairement conservé lors d'un reset.
export const RESET_CAMPAIGN_SYNC_KEYS = [
  SYNC_SUCCESS_KEYS.helloasso,
  SYNC_SUCCESS_KEYS.scrap,
  SYNC_SUCCESS_KEYS.eleves,
  MANUAL_SYNC_LOCK_KEYS.helloasso,
] as const;
