const COLORS = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--orange)",
  "var(--pink)",
  "var(--purple)",
  "var(--lime)",
];

export interface RecetteSegment {
  analytiqueId: string;
  analytiqueNom: string;
  montant: number;
}

interface Props {
  recettes: RecetteSegment[];
  total: number;
}

const eur0 = (n: number) =>
  n.toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

export default function RecettesPieChart({ recettes, total }: Props) {
  const circumference = 100;
  const segments = recettes.map((recette, index) => ({
    recette,
    percentage: total > 0 ? (recette.montant / total) * circumference : 0,
    offset: recettes
      .slice(0, index)
      .reduce(
        (sum, previous) => sum + (total > 0 ? (previous.montant / total) * circumference : 0),
        0,
      ),
  }));

  return (
    <div className="recettes-chart-layout">
      <div className="recettes-pie-wrap">
        <svg
          className="recettes-pie"
          viewBox="0 0 42 42"
          role="img"
          aria-labelledby="recettes-pie-title recettes-pie-desc"
        >
          <title id="recettes-pie-title">Répartition des recettes prévisionnelles</title>
          <desc id="recettes-pie-desc">
            {recettes
              .map((recette) => `${recette.analytiqueNom} : ${eur0(recette.montant)}`)
              .join(", ")}
          </desc>
          <circle className="recettes-pie__base" cx="21" cy="21" r="15.9155" />
          {segments.map(({ recette, percentage, offset: segmentOffset }, index) => {
            return (
              <circle
                key={recette.analytiqueId}
                className="recettes-pie__segment"
                cx="21"
                cy="21"
                r="15.9155"
                pathLength={circumference}
                stroke={COLORS[index % COLORS.length]}
                strokeDasharray={`${percentage} ${circumference - percentage}`}
                strokeDashoffset={-segmentOffset}
              />
            );
          })}
        </svg>
        <div className="recettes-pie-total" aria-hidden="true">
          <strong>{eur0(total)}</strong>
          <span>Total</span>
        </div>
      </div>

      <ul className="recettes-legend" aria-label="Détail des recettes">
        {recettes.map((recette, index) => {
          const percentage = total > 0 ? (recette.montant / total) * 100 : 0;
          return (
            <li key={recette.analytiqueId}>
              <span
                className="recettes-legend__color"
                style={{ backgroundColor: COLORS[index % COLORS.length] }}
                aria-hidden="true"
              />
              <span className="recettes-legend__label">{recette.analytiqueNom}</span>
              <strong className="font-mono">{eur0(recette.montant)}</strong>
              <span className="recettes-legend__percent">
                {percentage.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
