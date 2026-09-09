export type EtatReservationApercu =
  | "reservation_active"
  | "validation_cours"
  | "peut_reserver"
  | "inaccessible";

export function validationPendantCoursApercu({
  testAutonomie,
  age,
  vagueDepot,
}: {
  testAutonomie: string | null;
  age: number | null;
  vagueDepot: "vague_2" | "vague_3" | "historique";
}): boolean {
  return vagueDepot === "vague_2" &&
    testAutonomie !== "non_requis" &&
    testAutonomie !== "valide" &&
    !(age != null && age < 16);
}

export function etatReservationApercu({
  testAutonomie,
  age,
  reservationActive,
  vagueDepot,
}: {
  testAutonomie: string | null;
  age: number | null;
  reservationActive: boolean;
  vagueDepot: "vague_2" | "vague_3" | "historique";
}): EtatReservationApercu {
  if (reservationActive) return "reservation_active";
  if (
    testAutonomie === "non_requis" ||
    testAutonomie === "valide" ||
    (age != null && age < 16)
  ) {
    return "inaccessible";
  }
  if (validationPendantCoursApercu({ testAutonomie, age, vagueDepot })) {
    return "validation_cours";
  }
  return "peut_reserver";
}
