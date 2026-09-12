import { describe, expect, test } from "vitest";
import {
  DELAI_REVERIFICATION_SYNC_PAIEMENTS_MS,
  routePaiements,
  synchronisationPaiementsEnCours,
} from "./layoutState";

describe("cache de navigation Paiements", () => {
  test("active chaque lecture uniquement sur les sous-routes qui l'utilisent", () => {
    expect(routePaiements("/paiements")).toEqual({
      surValidation: true,
      surIndexTraites: false,
    });
    expect(routePaiements("/paiements/attente")).toEqual({
      surValidation: false,
      surIndexTraites: true,
    });
    expect(routePaiements("/paiements/approbations")).toEqual({
      surValidation: false,
      surIndexTraites: true,
    });
    expect(routePaiements("/paiements/config")).toEqual({
      surValidation: false,
      surIndexTraites: false,
    });
  });

  test("conserve la même fenêtre de quatre heures que le verrou automatique par défaut", () => {
    expect(DELAI_REVERIFICATION_SYNC_PAIEMENTS_MS).toBe(4 * 60 * 60_000);
  });

  test("désactive la synchronisation manuelle pendant la vérification automatique", () => {
    expect(synchronisationPaiementsEnCours(true, false, false)).toBe(true);
    expect(synchronisationPaiementsEnCours(true, true, false)).toBe(false);
    expect(synchronisationPaiementsEnCours(false, false, false)).toBe(false);
    expect(synchronisationPaiementsEnCours(false, true, true)).toBe(true);
  });
});
