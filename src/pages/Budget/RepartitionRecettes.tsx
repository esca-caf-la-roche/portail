import { useQuery } from "convex/react";
import { TriangleAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import CoursRentabiliteCard from "../../components/Budget/CoursRentabiliteCard";
import RecettesPieChart from "../../components/Budget/RecettesPieChart";
import { useSeason } from "../../contexts/SeasonContext";

export default function RepartitionRecettes() {
  const { season } = useSeason();
  const data = useQuery(api.budgetRecettes.getRepartition, { saison: season });

  if (data === undefined) {
    return <div className="loading">Chargement de la répartition des recettes…</div>;
  }

  const paieAbsente =
    data.cours.mineurs.coutSalarial === null || data.cours.adultes.coutSalarial === null;
  return (
    <div className="repartition-recettes">
      {data.recettes.length === 0 ? (
        <section className="card glass-card empty-state">
          <h2>Aucune recette prévisionnelle</h2>
          <p>
            Ajoutez des recettes dans l’onglet « Prévisionnel » pour afficher leur répartition.
          </p>
        </section>
      ) : (
        <section className="card glass-card recettes-chart-card">
          <div className="recettes-section-heading">
            <div>
              <h2>Toutes les recettes</h2>
              <p>Répartition par analytique du prévisionnel.</p>
            </div>
          </div>
          <RecettesPieChart recettes={data.recettes} total={data.totalRecettes} />
        </section>
      )}

      <section className="recettes-cours-section" aria-labelledby="rentabilite-cours-title">
        <div className="recettes-section-heading">
          <div>
            <h2 id="rentabilite-cours-title">Rentabilité des cours</h2>
            <p>
              Détail d’ESC01 et ESC02, calculé automatiquement en supposant tous les cours remplis.
            </p>
          </div>
        </div>

        {paieAbsente && (
          <div className="budget-alert budget-alert--warning" role="status">
            <TriangleAlert size={22} aria-hidden="true" />
            <span>
              La configuration de paie est incomplète pour {season} (paramètres, masse salariale
              ou moniteur sans ligne de paie). Les recettes restent visibles, mais le coût salarial
              et le résultat ne peuvent pas être calculés.
            </span>
          </div>
        )}

        <div className="cours-rentabilite-grid">
          <CoursRentabiliteCard title="ESC01 — Cours mineurs" {...data.cours.mineurs} accentClass="mineurs" participantLabel="mineur" />
          <CoursRentabiliteCard title="ESC02 — Cours adultes" {...data.cours.adultes} accentClass="adultes" participantLabel="adulte" />
        </div>
      </section>
    </div>
  );
}
