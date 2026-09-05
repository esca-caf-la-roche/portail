export type SyncSource = "helloasso" | "scrap" | "annuaire" | "eleves";

// Les imports administratifs restent à la demande ; quatre heures limitent
// les relectures des snapshots. Le parcours public garde sa fraîcheur de 15 min.
const SYNC_INTERVAL_MS = (Number(process.env.SYNC_TTL_MINUTES) || 240) * 60_000;
export const MANUAL_SYNC_INTERVAL_MS = 5 * 60_000;
export const CLUB_SYNC_MAX_AGE_MS = 15 * 60_000;
export const CLUB_SYNC_ATTEMPT_KEY = "last_attempt_sync_club";
export const CLUB_SYNC_COMPLETE_KEY = "last_complete_sync_club";
// SAISON-EXEMPT: verrou transversal conservé avec l'annuaire au reset de campagne.
export const ANNUAIRE_ATTEMPT_KEY = "last_attempt_sync_annuaire";

export { calculerCreneauAnnuaire } from "./syncStatus";

export const SYNC_SUCCESS_KEYS: Record<SyncSource, string> = {
  helloasso: "last_sync_helloasso",
  scrap: "last_sync_scrap",
  annuaire: "last_sync_annuaire",
  eleves: "last_sync_eleves",
};

export const AUTOMATIC_SYNC_INTERVALS_MS: Record<SyncSource, number> = {
  helloasso: SYNC_INTERVAL_MS,
  scrap: SYNC_INTERVAL_MS,
  annuaire: 0, // Calendrier Paris, pas de délai glissant.
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
  annuaire: 0, // Même calendrier pour les boutons manuels.
  eleves: MANUAL_SYNC_INTERVAL_MS,
};

// L'annuaire est transversal et volontairement conservé lors d'un reset.
export const RESET_CAMPAIGN_SYNC_KEYS = [
  SYNC_SUCCESS_KEYS.helloasso,
  SYNC_SUCCESS_KEYS.scrap,
  SYNC_SUCCESS_KEYS.eleves,
  MANUAL_SYNC_LOCK_KEYS.helloasso,
] as const;
