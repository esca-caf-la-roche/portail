import { describe, expect, it } from "vitest";
import {
  etatReservationApercu,
  validationPendantCoursApercu,
} from "./apercuAbonne.logic";

describe("etatReservationApercu", () => {
  it.each([
    ["valide", 20],
    ["non_requis", 20],
    [null, 15],
  ])("interdit une nouvelle réservation quand le test vaut %s et l’âge %s", (testAutonomie, age) => {
    expect(etatReservationApercu({ testAutonomie, age, reservationActive: false, vagueDepot: "vague_2" })).toBe("inaccessible");
  });

  it.each(["vague_3", "historique"] as const)(
    "permet une réservation en %s quand le test reste à faire",
    (vagueDepot) => {
      expect(etatReservationApercu({ testAutonomie: "requis", age: 18, reservationActive: false, vagueDepot })).toBe("peut_reserver");
    },
  );

  it("oriente la vague 2 vers la validation pendant le cours", () => {
    expect(etatReservationApercu({ testAutonomie: "requis", age: 18, reservationActive: false, vagueDepot: "vague_2" })).toBe("validation_cours");
  });

  it("conserve l’affichage d’une réservation active", () => {
    expect(etatReservationApercu({ testAutonomie: "requis", age: 18, reservationActive: true, vagueDepot: "vague_2" })).toBe("reservation_active");
    expect(validationPendantCoursApercu({ testAutonomie: "requis", age: 18, vagueDepot: "vague_2" })).toBe(true);
  });
});
