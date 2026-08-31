import { describe, expect, it } from "vitest";
import {
  calculerOptionsContactsCours,
  creerEmpreinteEmails,
  decouperEmailsEnLots,
  doitCopierEmailsParLots,
  filtrerContactsCours,
  normaliserHorairesFiltres,
  reconcilierFiltresContactsCours,
  type ContactCoursFiltrable,
  type FiltresContactsCours,
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

const contacts: ContactCoursFiltrable[] = [
  {
    prenom: "Léa",
    nom: "Martin",
    cours: "Débutant",
    horaire: "Lundi 18h",
    encadrants: "Alice",
  },
  {
    prenom: "Noé",
    nom: "Durand",
    cours: "Débutant",
    horaire: "Mardi 19h",
    encadrants: "Alice",
  },
  {
    prenom: "Inès",
    nom: "Petit",
    cours: "Perfectionnement",
    horaire: "Lundi 18h",
    encadrants: "Alice",
  },
  {
    prenom: "Tom",
    nom: "Robert",
    cours: "Débutant",
    horaire: "Mercredi 17h",
    encadrants: "Bob",
  },
];

const filtresVides: FiltresContactsCours = {
  recherche: "",
  cours: "",
  horaires: [],
  encadrant: "",
};

describe("filtrerContactsCours avec plusieurs horaires", () => {
  it("ne filtre pas les horaires quand aucune case n'est cochée", () => {
    expect(filtrerContactsCours(contacts, filtresVides)).toEqual(contacts);
  });

  it("applique un OU entre horaires et un ET avec les autres facettes", () => {
    const resultat = filtrerContactsCours(contacts, {
      ...filtresVides,
      cours: "Débutant",
      horaires: ["Lundi 18h", "Mardi 19h"],
      encadrant: "Alice",
    });

    expect(resultat.map((contact) => contact.prenom)).toEqual(["Léa", "Noé"]);
  });

  it("propose tous les horaires compatibles sans s'auto-filtrer", () => {
    const options = calculerOptionsContactsCours(contacts, {
      ...filtresVides,
      cours: "Débutant",
      horaires: ["Lundi 18h"],
    });

    expect(options.horaires).toEqual([
      "Lundi 18h",
      "Mardi 19h",
      "Mercredi 17h",
    ]);
  });
});

describe("validation des horaires filtrés", () => {
  it("conserve les choix encore disponibles et retire doublons et choix invalides", () => {
    const resultat = reconcilierFiltresContactsCours(
      {
        ...filtresVides,
        horaires: ["Lundi 18h", "Horaire supprimé", "Lundi 18h"],
      },
      {
        cours: ["Débutant"],
        horaires: ["Lundi 18h", "Mardi 19h"],
        encadrants: ["Alice"],
      },
    );

    expect(resultat.horaires).toEqual(["Lundi 18h"]);
  });

  it("nettoie et déduplique l'état reçu par la page de copie", () => {
    expect(normaliserHorairesFiltres([
      " Lundi 18h ",
      "Mardi 19h",
      "Lundi 18h",
      " ",
    ])).toEqual(["Lundi 18h", "Mardi 19h"]);
  });

  it("refuse un état de navigation qui ne contient pas que des horaires texte", () => {
    expect(normaliserHorairesFiltres(["Lundi 18h", 42])).toBeNull();
    expect(normaliserHorairesFiltres("Lundi 18h")).toBeNull();
  });
});
