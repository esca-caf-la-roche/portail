import { describe, expect, it } from "vitest";
import { moduleSaisonnier, saisonParDefaut } from "./seasonRouting";

describe("moduleSaisonnier", () => {
  it("conserve la même racine pour les sous-routes d'un module", () => {
    expect(moduleSaisonnier("/budget")).toBe("/budget");
    expect(moduleSaisonnier("/budget/parametres")).toBe("/budget");
  });

  it("distingue les modules saisonniers et les routes hors saison", () => {
    expect(moduleSaisonnier("/compta")).toBe("/compta");
    expect(moduleSaisonnier("/gestion-samedis")).toBe("/gestion-samedis");
    expect(moduleSaisonnier("/samedis")).toBe("/samedis");
    expect(moduleSaisonnier("/paiements")).toBeNull();
    expect(moduleSaisonnier("/")).toBeNull();
  });
});

describe("saisonParDefaut", () => {
  it("retourne exclusivement la saison marquée par Convex", () => {
    expect(saisonParDefaut([
      { nom: "2026-27" },
      { nom: "2025-26", isDefault: true },
    ])).toBe("2025-26");
  });

  it("n'invente aucun fallback", () => {
    expect(saisonParDefaut(undefined)).toBeNull();
    expect(saisonParDefaut([])).toBeNull();
    expect(saisonParDefaut([{ nom: "2026-27" }])).toBeNull();
  });
});
