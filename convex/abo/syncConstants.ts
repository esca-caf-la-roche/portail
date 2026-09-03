export type SyncSource = "helloasso" | "scrap" | "annuaire" | "eleves";

const SYNC_INTERVAL_MS = (Number(process.env.SYNC_TTL_MINUTES) || 60) * 60_000;
export const MANUAL_SYNC_INTERVAL_MS = 5 * 60_000;
// SAISON-EXEMPT: verrou transversal conservé avec l'annuaire au reset de campagne.
export const ANNUAIRE_ATTEMPT_KEY = "last_attempt_sync_annuaire";

const parisDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parisParts(ms: number) {
  const parts = parisDateFormatter.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)!.value);
  return { year: part("year"), month: part("month"), day: part("day"),
    hour: part("hour"), minute: part("minute"), second: part("second") };
}

// Les heures 7 et 9 sont non ambiguës, y compris au changement d'heure.
function parisMorningMs(year: number, month: number, day: number, hour: number) {
  const wallMs = Date.UTC(year, month - 1, day, hour);
  let utcMs = wallMs;
  for (let i = 0; i < 2; i++) {
    const p = parisParts(utcMs);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
    utcMs = wallMs - offset;
  }
  return utcMs;
}

// Un seul appel dans le créneau courant : aucun rattrapage de 7 h après 9 h.
// Le marqueur historique compte pour son créneau, mais 5 h 30 ne bloque pas 7 h.
export function calculerCreneauAnnuaire(
  maintenantMs: number,
  tentative?: string,
  historique?: string,
) {
  const p = parisParts(maintenantMs);
  const sept = parisMorningMs(p.year, p.month, p.day, 7);
  const neuf = parisMorningMs(p.year, p.month, p.day, 9);
  const debutMs = maintenantMs < sept ? null : maintenantMs < neuf ? sept : neuf;
  const derniereTentative = Date.parse(tentative ?? historique ?? "") || 0;
  const disponible = debutMs !== null && derniereTentative < debutMs;
  const prochaineMs = maintenantMs < sept ? sept : maintenantMs < neuf ? neuf
    : parisMorningMs(p.year, p.month, p.day + 1, 7);
  return {
    disponible,
    nextSyncAt: disponible ? null : new Date(prochaineMs).toISOString(),
  };
}

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
