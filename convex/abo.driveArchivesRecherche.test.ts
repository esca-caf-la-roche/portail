import { describe, expect, test } from "vitest";
import { nomFichierTestAutonomie } from "./abo/driveArchivesRecherche";

describe("nom des fichiers de test d'autonomie", () => {
  test("conserve le nom historique pour un test validé", () => {
    expect(nomFichierTestAutonomie("dupont", "JEAN-pierre", "valide"))
      .toBe("DUPONT Jean-Pierre");
  });

  test("ajoute KO à la fin pour un test non validé", () => {
    expect(nomFichierTestAutonomie("dupont", "JEAN-pierre", "non_valide"))
      .toBe("DUPONT Jean-Pierre KO");
  });
});
