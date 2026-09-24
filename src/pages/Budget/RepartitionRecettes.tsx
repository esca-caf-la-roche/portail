import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Save, TriangleAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import CoursRentabiliteCard from "../../components/Budget/CoursRentabiliteCard";
import RecettesPieChart from "../../components/Budget/RecettesPieChart";
import { useSeason } from "../../contexts/SeasonContext";

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") return data;
  }
  return error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
}

export default function RepartitionRecettes() {
  const { season } = useSeason();
  const data = useQuery(api.budgetRecettes.getRepartition, { saison: season });
  const setEffectifs = useMutation(api.effectifs.setEffectifsCours);
  const [mineurs, setMineurs] = useState("");
  const [adultes, setAdultes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!data) return;
    setMineurs(data.cours.mineurs.nbParticipants?.toString() ?? "");
    setAdultes(data.cours.adultes.nbParticipants?.toString() ?? "");
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (data === undefined) {
    return <div className="loading">Chargement de la répartition des recettes…</div>;
  }

  const paieAbsente =
    data.cours.mineurs.coutSalarial === null || data.cours.adultes.coutSalarial === null;
  const nonClasses = data.cours.nonClasses;
  const hasNonClasses = nonClasses.nbCreneaux > 0;

  const saveEffectifs = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const nbMineursCours = Number(mineurs);
    const nbAdultesCours = Number(adultes);
    if (!Number.isFinite(nbMineursCours) || !Number.isFinite(nbAdultesCours) || nbMineursCours < 0 || nbAdultesCours < 0) {
      setError("Les effectifs doivent être des nombres positifs ou nuls.");
      return;
    }
    setSaving(true);
    try {
      await setEffectifs({ saison: season, nbMineursCours, nbAdultesCours });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

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
            <p>Recettes maximales prévues moins le coût salarial affecté aux cours.</p>
          </div>
        </div>

        {paieAbsente && (
          <div className="budget-alert budget-alert--warning" role="status">
            <TriangleAlert size={22} aria-hidden="true" />
            <span>
              Les paramètres de paie ou la masse salariale sont absents pour {season}. Les recettes
              restent visibles, mais le coût salarial et le résultat ne peuvent pas être calculés.
            </span>
          </div>
        )}

        {hasNonClasses && (
          <div className="budget-alert budget-alert--danger" role="alert">
            <TriangleAlert size={22} aria-hidden="true" />
            <span>
              {nonClasses.nbCreneaux} ancien{nonClasses.nbCreneaux > 1 ? "s" : ""} créneau{nonClasses.nbCreneaux > 1 ? "x" : ""}
              {" "}sans public cible ({nonClasses.heures.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h,
              recette de {nonClasses.recette.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}).
              Classez-les dans l’onglet « Planning des cours » pour les inclure dans les résultats.
            </span>
          </div>
        )}

        <form className="effectifs-cours-form" onSubmit={saveEffectifs}>
          <div>
            <h3>Effectifs réels</h3>
            <p>Utilisés pour calculer le résultat par participant.</p>
          </div>
          <label htmlFor="effectif-mineurs">
            Mineurs en cours
            <input
              id="effectif-mineurs"
              className="input-field"
              type="number"
              min="0"
              max="10000"
              step="1"
              value={mineurs}
              onChange={(event) => setMineurs(event.target.value)}
              required
            />
          </label>
          <label htmlFor="effectif-adultes">
            Adultes en cours
            <input
              id="effectif-adultes"
              className="input-field"
              type="number"
              min="0"
              max="10000"
              step="1"
              value={adultes}
              onChange={(event) => setAdultes(event.target.value)}
              required
            />
          </label>
          <button className="btn-primary" type="submit" disabled={saving}>
            <Save size={18} aria-hidden="true" /> {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
          {error && <p className="effectifs-cours-form__error" role="alert">{error}</p>}
        </form>

        <div className="cours-rentabilite-grid">
          <CoursRentabiliteCard title="Cours mineurs" {...data.cours.mineurs} accentClass="mineurs" participantLabel="mineur" />
          <CoursRentabiliteCard title="Cours adultes" {...data.cours.adultes} accentClass="adultes" participantLabel="adulte" />
        </div>
      </section>
    </div>
  );
}
