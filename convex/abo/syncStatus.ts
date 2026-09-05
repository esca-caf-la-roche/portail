// Calculs purs partagés entre serveur et navigateur, sans accès aux données.
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

export function calculerStatutSource(
  valeur: string | undefined,
  ttlMs: number,
  maintenantMs?: number,
) {
  const lastMs = valeur ? Date.parse(valeur) : NaN;
  const prochaineMs = lastMs + ttlMs;
  return {
    lastSyncAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    nextSyncAt: Number.isFinite(prochaineMs)
      && (maintenantMs === undefined || prochaineMs > maintenantMs)
      ? new Date(prochaineMs).toISOString()
      : null,
  };
}

export function calculerStatutAnnuaire(valeur: string | undefined, tentative: string | undefined, maintenantMs?: number) {
  return {
    lastSyncAt: calculerStatutSource(valeur, 0).lastSyncAt,
    lastAttemptAt: tentative ?? null,
    nextSyncAt: maintenantMs === undefined ? null
      : calculerCreneauAnnuaire(maintenantMs, tentative, valeur).nextSyncAt,
  };
}

type StatutSource = {
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastAttemptAt?: string | null;
  manualNextSyncAt?: string | null;
};

// Le passage du temps ne provoque aucune lecture Convex. Les marqueurs reçus
// restent réactifs ; les réservations côté serveur restent seules décisionnaires.
export function actualiserStatutSource<T extends StatutSource>(
  source: string,
  statut: T,
  maintenantMs: number,
): T {
  const prochaine = (date: string | null | undefined) =>
    date && Date.parse(date) > maintenantMs ? date : null;
  const nextSyncAt = source === "annuaire"
    ? calculerCreneauAnnuaire(
      maintenantMs, statut.lastAttemptAt ?? undefined, statut.lastSyncAt ?? undefined,
    ).nextSyncAt
    : prochaine(statut.nextSyncAt);
  return {
    ...statut,
    nextSyncAt,
    ...("manualNextSyncAt" in statut ? {
      manualNextSyncAt: source === "annuaire" ? nextSyncAt : prochaine(statut.manualNextSyncAt),
    } : {}),
  };
}

