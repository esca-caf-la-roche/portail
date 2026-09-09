export type EtatReservationApercu =
  | "reservation_active"
  | "peut_reserver"
  | "inaccessible";

export function etatReservationApercu({
  testAutonomie,
  age,
  reservationActive,
}: {
  testAutonomie: string | null;
  age: number | null;
  reservationActive: boolean;
}): EtatReservationApercu {
  if (reservationActive) return "reservation_active";
  if (
    testAutonomie === "non_requis" ||
    testAutonomie === "valide" ||
    (age != null && age < 16)
  ) {
    return "inaccessible";
  }
  return "peut_reserver";
}
