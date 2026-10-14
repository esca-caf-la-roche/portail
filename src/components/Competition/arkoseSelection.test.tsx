import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Id } from "../../../convex/_generated/dataModel";
import ArkoseAmbassadeurSelect from "./ArkoseAmbassadeurSelect";
import { optionsArkose, selectionArkoseValide } from "./arkoseSelection";

const id = (value: string) => value as Id<"competition_ambassadeurs">;
const ambassadeurs = [
  { _id: id("a"), prenom: "Élodie", nom: "Dupré", dateNaissance: "2010-03-02" },
  { _id: id("b"), prenom: "Jean", nom: "Martin", dateNaissance: "2011-04-03" },
  { _id: id("c"), prenom: "Léa", nom: "Martin", dateNaissance: "2012-05-04" },
];

describe("sélection compacte Arkose", () => {
  it("recherche sans accents, sans dépendre de l’ordre nom/prénom", () => {
    expect(optionsArkose(ambassadeurs, [], [], " DUPRE elodie ").map((item) => item._id)).toEqual([id("a")]);
  });
  it("exclut les sélectionnés et les liens existants", () => {
    expect(optionsArkose(ambassadeurs, [id("a")], [id("b")], "").map((item) => item._id)).toEqual([id("c")]);
  });
  it("conserve la sélection lorsque la recherche ne correspond plus", () => {
    const selection = [id("a")];
    expect(optionsArkose(ambassadeurs, selection, [], "Martin")).toHaveLength(2);
    expect(selectionArkoseValide(selection, [])).toEqual(selection);
  });
  it("déduplique et limite à 20 en comptant les liens existants", () => {
    expect(selectionArkoseValide([id("a"), id("a"), id("b")], [id("b")])).toEqual([id("a")]);
    const lies = Array.from({ length: 19 }, (_, index) => id(`lie-${index}`));
    expect(selectionArkoseValide([id("a"), id("b")], lies)).toEqual([id("a")]);
    expect(selectionArkoseValide([id("a")], [...lies, id("b")])).toEqual([]);
  });
  it("rend un select natif, des labels visibles et les sélections retirables", () => {
    const html = renderToStaticMarkup(<ArkoseAmbassadeurSelect ambassadeurs={ambassadeurs} selection={[id("a")]} lies={[id("b")]} signataire="Adulte Test" disabled={false} onChange={() => {}} />);
    expect(html).toContain("<select");
    expect(html).toContain("Rechercher un ambassadeur");
    expect(html).toContain("Ajouter à la sélection");
    expect(html).toContain("Retirer Élodie Dupré de la sélection");
    expect(html).not.toContain('value="a"');
    expect(html).not.toContain('value="b"');
    expect(html).toContain('value="c"');
  });
});
