interface Props {
  title: string;
  recette: number;
  coutSalarial: number | null;
  resultat: number | null;
  nbParticipants: number | null;
  resultatParParticipant: number | null;
  accentClass: "mineurs" | "adultes";
  participantLabel: string;
}

const eur = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

export default function CoursRentabiliteCard({
  title,
  recette,
  coutSalarial,
  resultat,
  nbParticipants,
  resultatParParticipant,
  accentClass,
  participantLabel,
}: Props) {
  return (
    <article className={`cours-rentabilite-card cours-rentabilite-card--${accentClass}`}>
      <h3>{title}</h3>
      <dl className="cours-rentabilite-card__formula">
        <div>
          <dt>Recette cours</dt>
          <dd>{eur(recette)}</dd>
        </div>
        <div aria-hidden="true" className="cours-rentabilite-card__operator">−</div>
        <div>
          <dt>Dépense salariale</dt>
          <dd>{coutSalarial === null ? "Non disponible" : eur(coutSalarial)}</dd>
        </div>
        <div aria-hidden="true" className="cours-rentabilite-card__operator">=</div>
        <div className="cours-rentabilite-card__result">
          <dt>Résultat</dt>
          <dd>{resultat === null ? "À calculer" : eur(resultat)}</dd>
        </div>
      </dl>
      <div className="cours-rentabilite-card__participant">
        <span>
          {nbParticipants === null
            ? "Effectif non renseigné"
            : `${nbParticipants.toLocaleString("fr-FR")} ${participantLabel}${nbParticipants > 1 ? "s" : ""} en cours`}
        </span>
        <strong>
          {resultatParParticipant === null ? "—" : `${eur(resultatParParticipant)} / ${participantLabel} en cours`}
        </strong>
      </div>
    </article>
  );
}
