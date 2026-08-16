import { describe, expect, it } from "vitest";
import {
  creerEmpreinteEmails,
  decouperEmailsEnLots,
  doitCopierEmailsParLots,
} from "./contactsCours";

function creerEmails(nombre: number): string[] {
  return Array.from(
    { length: nombre },
    (_, index) => `eleve-${index + 1}@example.fr`,
  );
}

describe("decouperEmailsEnLots", () => {
  it.each([
    { nombre: 0, tailles: [] },
    { nombre: 99, tailles: [99] },
    { nombre: 100, tailles: [99, 1] },
    { nombre: 101, tailles: [99, 2] },
    { nombre: 198, tailles: [99, 99] },
    { nombre: 199, tailles: [99, 99, 1] },
  ])("découpe $nombre emails en lots de 99", ({ nombre, tailles }) => {
    const emails = creerEmails(nombre);
    const lots = decouperEmailsEnLots(emails);

    expect(lots.map((lot) => lot.length)).toEqual(tailles);
    expect(lots.flat()).toEqual(emails);
  });
});

describe("doitCopierEmailsParLots", () => {
  it("garde la copie directe jusqu'à 100 adresses", () => {
    expect(doitCopierEmailsParLots(100)).toBe(false);
  });

  it("ouvre la page de lots à partir de 101 adresses", () => {
    expect(doitCopierEmailsParLots(101)).toBe(true);
  });
});

describe("creerEmpreinteEmails", () => {
  it("réinitialise la progression si l'ordre des lots peut changer", () => {
    const emails = creerEmails(101);

    expect(creerEmpreinteEmails(emails)).not.toBe(
      creerEmpreinteEmails([...emails].reverse()),
    );
  });
});
