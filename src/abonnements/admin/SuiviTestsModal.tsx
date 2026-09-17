import { useEffect, useId, useRef, useState } from "react";
import { formatJour, formatTranche } from "../lib/tests";

export type CandidatSuiviTest = {
  cle: string;
  nom: string;
  prenom: string;
  licence: string | null;
  estEleveEnCours: boolean;
  statut: "en_attente" | "reserve" | "avec_moniteur" | "a_qualifier" | "valide" | "non_valide" | "absent";
  trancheDebut: string | null;
  trancheFin: string | null;
};

const LIBELLES_STATUT: Record<CandidatSuiviTest["statut"], string> = {
  en_attente: "En attente de créneau",
  reserve: "Créneau réservé",
  avec_moniteur: "Élève en cours — test avec son moniteur",
  a_qualifier: "Résultat à qualifier",
  valide: "Test validé",
  non_valide: "Test non validé",
  absent: "Absent",
};

type FiltreStatut = "tous" | CandidatSuiviTest["statut"];

const FILTRES: Array<{ valeur: FiltreStatut; label: string }> = [
  { valeur: "tous", label: "Tous" },
  { valeur: "en_attente", label: "Sans réservation" },
  { valeur: "reserve", label: "Réservés" },
  { valeur: "avec_moniteur", label: "En cours d’escalade" },
  { valeur: "a_qualifier", label: "À qualifier" },
  { valeur: "valide", label: "Validés" },
  { valeur: "non_valide", label: "Non validés" },
  { valeur: "absent", label: "Absents" },
];

export default function SuiviTestsModal({
  candidats,
  onFermer,
}: {
  candidats: CandidatSuiviTest[];
  onFermer: () => void;
}) {
  const [filtre, setFiltre] = useState<FiltreStatut>("tous");
  const titreId = useId();
  const descriptionId = useId();
  const modalRef = useRef<HTMLElement>(null);
  const fermerRef = useRef<HTMLButtonElement>(null);
  const onFermerRef = useRef(onFermer);

  useEffect(() => {
    onFermerRef.current = onFermer;
  }, [onFermer]);

  useEffect(() => {
    const precedent = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    fermerRef.current?.focus();

    function gererClavier(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onFermerRef.current();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;

      const elements = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (elements.length === 0) {
        event.preventDefault();
        modalRef.current.focus();
        return;
      }

      const premier = elements[0];
      const dernier = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === premier) {
        event.preventDefault();
        dernier.focus();
      } else if (!event.shiftKey && document.activeElement === dernier) {
        event.preventDefault();
        premier.focus();
      }
    }

    window.addEventListener("keydown", gererClavier);
    return () => {
      window.removeEventListener("keydown", gererClavier);
      precedent?.focus();
    };
  }, []);

  const candidatsFiltres = filtre === "tous"
    ? candidats
    : candidats.filter((candidat) => candidat.statut === filtre);

  return (
    <div
      className="abo-admin-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onFermer();
      }}
    >
      <section
        ref={modalRef}
        className="abo-admin-modal abo-admin-tests-followup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titreId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="abo-admin-modal-header">
          <h3 id={titreId}>Suivi des tests d&apos;autonomie</h3>
          <button
            ref={fermerRef}
            type="button"
            className="abo-admin-modal-close"
            onClick={onFermer}
            aria-label="Fermer le suivi des tests"
          >
            ×
          </button>
        </div>

        <p id={descriptionId} className="abo-admin-modal-copy">
          Retrouvez les personnes qui doivent passer un test et l&apos;avancement de leur réservation.
        </p>

        <div className="abo-admin-toolbar abo-admin-tests-filter-tabs" role="group" aria-label="Filtrer les personnes par statut">
          {FILTRES.map((option) => (
            <button
              key={option.valeur}
              type="button"
              className="abo-admin-button"
              aria-pressed={filtre === option.valeur}
              onClick={() => setFiltre(option.valeur)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <p className="abo-admin-meta" aria-live="polite">
          {candidatsFiltres.length} personne{candidatsFiltres.length === 1 ? "" : "s"} affichée{candidatsFiltres.length === 1 ? "" : "s"}
        </p>

        {candidatsFiltres.length === 0 ? (
          <p className="abo-admin-empty">Aucune personne ne correspond à ce filtre.</p>
        ) : (
          <ul className="abo-admin-tests-followup-list">
            {candidatsFiltres.map((candidat) => (
              <li key={candidat.cle} className="abo-admin-tests-followup-person">
                <div className="abo-admin-tests-followup-identity">
                  <strong>{`${candidat.prenom} ${candidat.nom}`.trim() || "Personne sans nom"}</strong>
                  <span className="abo-admin-meta">
                    {candidat.licence ? `Licence ${candidat.licence}` : "Licence non renseignée"}
                  </span>
                  {candidat.estEleveEnCours && candidat.statut !== "avec_moniteur" && (
                    <span className="abo-admin-tests-followup-course-badge">
                      Élève en cours — test avec son moniteur
                    </span>
                  )}
                </div>
                <div className="abo-admin-tests-followup-state">
                  <span className={`abo-admin-tests-followup-badge abo-admin-tests-followup-badge--${candidat.statut}`}>
                    {LIBELLES_STATUT[candidat.statut]}
                  </span>
                  {candidat.trancheDebut && (
                    <span className="abo-admin-tests-followup-slot">
                      {formatJour(candidat.trancheDebut)} · {formatTranche(candidat.trancheDebut, candidat.trancheFin)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
