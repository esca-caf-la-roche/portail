import { describe, expect, it } from "vitest";
import { etatReservationApercu } from "./apercuAbonne.logic";

describe("etatReservationApercu", () => {
  it.each([
    ["valide", 20],
    ["non_requis", 20],
    [null, 15],
  ])("interdit une nouvelle réservation quand le test vaut %s et l’âge %s", (testAutonomie, age) => {
    expect(etatReservationApercu({ testAutonomie, age, reservationActive: false })).toBe("inaccessible");
  });

  it("permet une réservation quand le test reste à faire", () => {
    expect(etatReservationApercu({ testAutonomie: "requis", age: 18, reservationActive: false })).toBe("peut_reserver");
  });

  it("conserve l’affichage d’une réservation active", () => {
    expect(etatReservationApercu({ testAutonomie: "valide", age: 18, reservationActive: true })).toBe("reservation_active");
  });
});
