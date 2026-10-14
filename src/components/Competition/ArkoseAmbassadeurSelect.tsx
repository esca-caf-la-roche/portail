import { useId, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import { optionsArkose, selectionArkoseValide, type AmbassadeurOption } from "./arkoseSelection";

type Props = {
  ambassadeurs: readonly AmbassadeurOption[];
  selection: Id<"competition_ambassadeurs">[];
  lies: Id<"competition_ambassadeurs">[];
  signataire: string;
  disabled: boolean;
  onChange: (ids: Id<"competition_ambassadeurs">[]) => void;
};

export default function ArkoseAmbassadeurSelect({ ambassadeurs, selection, lies, signataire, disabled, onChange }: Props) {
  const [search, setSearch] = useState("");
  const id = useId();
  const selected = selectionArkoseValide(selection, lies);
  const options = optionsArkose(ambassadeurs, selected, lies, search);
  const full = selected.length + lies.length >= 20;
  return <fieldset disabled={disabled} className="competition-arkose-picker">
    <legend>Ambassadeurs pour {signataire}</legend>
    <label htmlFor={`${id}-search`}>Rechercher un ambassadeur
      <input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nom ou prénom" />
    </label>
    <label htmlFor={`${id}-select`}>Ajouter à la sélection
      <select id={`${id}-select`} value="" disabled={full || options.length === 0} aria-describedby={`${id}-help`} onChange={(event) => {
        const option = options.find((candidate) => candidate._id === event.target.value);
        if (option && !full) onChange([...selected, option._id]);
      }}>
        <option value="">Choisir un ambassadeur…</option>
        {options.map((option) => <option key={option._id} value={option._id}>{option.prenom} {option.nom} · {option.dateNaissance.split("-").reverse().join("/")}</option>)}
      </select>
    </label>
    <p id={`${id}-help`} className="competition-picker-help" role="status">{full ? "Limite de 20 ambassadeurs atteinte." : options.length === 0 ? "Aucun ambassadeur disponible pour cette recherche." : "Ajoutez les ambassadeurs un par un."} {selected.length} sélectionné(s) · {lies.length} déjà lié(s).</p>
    {selected.length > 0 && <ul className="competition-picker-selection" aria-label="Ambassadeurs sélectionnés">
      {selected.map((selectedId) => {
        const option = ambassadeurs.find((candidate) => candidate._id === selectedId);
        const name = option ? `${option.prenom} ${option.nom}` : "Ambassadeur indisponible";
        return <li key={selectedId} className="competition-arkose-link"><span>{name}</span><button type="button" className="btn-text" aria-label={`Retirer ${name} de la sélection`} onClick={() => onChange(selected.filter((value) => value !== selectedId))}>Retirer</button></li>;
      })}
    </ul>}
  </fieldset>;
}
