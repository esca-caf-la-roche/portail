// Helpers purs du module Abonnements (runtime Convex par défaut, importables
// depuis les queries/mutations). Portage des triggers/normalisation Postgres de
// abo-esca-new (pas de generated columns ni d'extension unaccent/pg_trgm en Convex).

// Normalisation nom+prénom (clé de matching) : MAJUSCULES, sans accents, espaces
// réduits. Équivalent de public.normaliser_nom_prenom(nom, prenom) :
//   upper(btrim(regexp_replace(unaccent(nom || ' ' || prenom), '\s+', ' ', 'g')))
// Ex. «  Dûpont  » + « JEAN  rené » → "DUPONT JEAN RENE".
export function normaliserNomPrenom(nom?: string | null, prenom?: string | null): string {
  const brut = `${nom ?? ""} ${prenom ?? ""}`;
  return brut
    .normalize("NFD") // sépare lettres et diacritiques (é → e + ́)
    .replace(/[̀-ͯ]/g, "") // supprime les diacritiques
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Canonisation d'un numéro de licence (équivalent du trigger tg_normaliser_licence).
// Le format canonique = 12 chiffres. On accepte 12 ou 14 chiffres saisis
// (14 = clé de contrôle incluse) et on retient les 12 premiers. Toute autre
// longueur (ou vide) → null (licence considérée comme non renseignée).
export function canoniserLicence(licence?: string | null): string | null {
  const digits = (licence ?? "").replace(/\D/g, "");
  if (digits.length === 12 || digits.length === 14) return digits.slice(0, 12);
  return null;
}

// Vrai si la chaîne saisie a un format de licence plausible (12 ou 14 chiffres).
export function licenceFormatOk(licence?: string | null): boolean {
  const len = (licence ?? "").replace(/\D/g, "").length;
  return len === 12 || len === 14;
}

// Trigrammes (avec padding, façon pg_trgm) d'une chaîne normalisée. Exporté
// pour permettre aux appelants de pré-calculer un annuaire une seule fois
// (évite le O(n×m) de recalcul quand on compare beaucoup de candidats).
export function trigrammes(s: string): Set<string> {
  const t = `  ${s.trim().toLowerCase()} `;
  const set = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

// Similarité trigramme (Jaccard) ∈ [0,1] à partir de deux jeux de trigrammes
// déjà calculés — cœur de similarite(), réutilisable pour éviter de refaire
// trigrammes() à chaque comparaison quand un côté est fixe (ex: annuaire).
export function similariteTrigrammes(ta: Set<string>, tb: Set<string>): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Similarité trigramme (Jaccard) ∈ [0,1], portage approché de pg_trgm.similarity
// pour classer les candidats licence par proximité nom/prénom.
export function similarite(a: string, b: string): number {
  if (!a || !b) return 0;
  return similariteTrigrammes(trigrammes(a), trigrammes(b));
}

// Vrai si on est en septembre en Europe/Paris (fenêtre de tolérance licence
// N-1 pour les élèves déjà en cours la saison précédente).
export function estSeptembreParis(nowMs: number): boolean {
  const mois = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    month: "numeric",
  }).format(new Date(nowMs));
  return Number(mois) === 9;
}

// ── Réservations de test d'autonomie : primitives partagées ──────────────
// Slot de base d'un créneau de test (20 min) et durée de repli d'une
// réservation historique (40/60 min) dépourvue de tranche_fin.
export const SLOT_TEST_MS = 20 * 60 * 1000;
export const DUREE_RESERVATION_LEGACY_MS = 3 * SLOT_TEST_MS;

// Fin d'une réservation en ms (fallback legacy si tranche_fin absente/invalide).
export function finReservationMs(reservation: {
  tranche: string;
  tranche_fin?: string;
}): number | null {
  const debut = Date.parse(reservation.tranche);
  if (!Number.isFinite(debut)) return null;
  const fin = reservation.tranche_fin
    ? Date.parse(reservation.tranche_fin)
    : Number.NaN;
  return Number.isFinite(fin) && fin > debut
    ? fin
    : debut + DUREE_RESERVATION_LEGACY_MS;
}

type ReservationStatut = {
  statut: "active" | "annulee";
  resultat_test?: "valide" | "non_valide" | "absent";
  tranche: string;
  tranche_fin?: string;
};

// Une tentative « validée » bloque durablement (on ne repasse pas un test
// réussi). « Non validée » ou « Absente » reste un historique non bloquant. Une
// réservation passée sans résultat renseigné (absence non marquée) ne bloque
// plus : le créneau passé n'étant plus annulable, la bloquer enfermerait
// l'utilisateur dans une impasse (erreur P0011 sans issue).
export function estReservationBloquante(
  reservation: ReservationStatut,
  maintenantMs: number,
): boolean {
  if (reservation.statut !== "active") return false;
  if (
    reservation.resultat_test === "non_valide" ||
    reservation.resultat_test === "absent"
  ) {
    return false;
  }
  if (reservation.resultat_test === "valide") return true;
  const fin = finReservationMs(reservation);
  return fin !== null && fin > maintenantMs;
}

// Réservation affichée comme « RDV courant » pour le candidat : active, sans
// résultat encore saisi et non terminée. Prédicat unique partagé par les
// parcours dossier et direct pour éviter toute divergence.
export function estReservationRdvCourante(
  reservation: ReservationStatut,
  maintenantMs: number,
): boolean {
  if (reservation.statut !== "active") return false;
  if (reservation.resultat_test !== undefined) return false;
  const fin = finReservationMs(reservation);
  return fin !== null && fin > maintenantMs;
}
