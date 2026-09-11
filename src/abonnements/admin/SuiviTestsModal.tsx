import { useEffect, useId, useRef } from "react";
import { formatJour, formatTranche } from "../lib/tests";

export type CandidatSuiviTest = {
  cle: string;
  nom: string;
  prenom: string;
  licence: string | null;
  estEleveEnCours: boolean;
  statut: "en_attente" | "reserve" | "passe";
  trancheDebut: string | null;
  trancheFin: string | null;
};

const LIBELLES_STATUT: Record<CandidatSuiviTest["statut"], string> = {
  en_attente: "En attente de créneau",
  reserve: "Créneau réservé",
  passe: "Test passé",
};

export default function SuiviTestsModal({
  candidats,
  aPlanifier,
  reserves,
  passes,
  onFermer,
}: {
  candidats: CandidatSuiviTest[];
  aPlanifier: number;
  reserves: number;
  passes: number;
  onFermer: () => void;
}) {
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

        <dl className="abo-admin-tests-followup-summary">
          <div>
            <dt>En attente</dt>
            <dd>{aPlanifier - reserves}</dd>
          </div>
          <div>
            <dt>Réservés</dt>
            <dd>{reserves}</dd>
          </div>
          <div>
            <dt>Passés</dt>
            <dd>{passes}</dd>
          </div>
        </dl>

        {candidats.length === 0 ? (
          <p className="abo-admin-empty">Aucune personne n&apos;a de test d&apos;autonomie à suivre.</p>
        ) : (
          <ul className="abo-admin-tests-followup-list">
            {candidats.map((candidat) => (
              <li key={candidat.cle} className="abo-admin-tests-followup-person">
                <div className="abo-admin-tests-followup-identity">
                  <strong>{`${candidat.prenom} ${candidat.nom}`.trim() || "Personne sans nom"}</strong>
                  <span className="abo-admin-meta">
                    {candidat.licence ? `Licence ${candidat.licence}` : "Licence non renseignée"}
                  </span>
                  {candidat.estEleveEnCours && (
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
