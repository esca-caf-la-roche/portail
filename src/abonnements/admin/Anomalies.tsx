import { type FormEvent, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError, formatDateHeure } from "../lib/errors";

type VueAnomalies = "a_traiter" | "acquittee";

export default function Anomalies() {
  const anomalies = useQuery(api.abo.compteur.vAnomalies, {});
  const acquitterAnomalie = useMutation(api.abo.compteur.acquitterAnomalie);
  const reactiverAnomalie = useMutation(api.abo.compteur.reactiverAnomalie);
  const [vue, setVue] = useState<VueAnomalies>("a_traiter");
  const [formulaireOuvert, setFormulaireOuvert] = useState<string | null>(null);
  const [justification, setJustification] = useState("");
  const [actionEnCours, setActionEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [annonce, setAnnonce] = useState("");
  const boutonATraiterRef = useRef<HTMLButtonElement>(null);
  const boutonMasqueesRef = useRef<HTMLButtonElement>(null);

  if (anomalies === undefined) return <p role="status">Chargement…</p>;

  const aTraiter = anomalies.filter((anomalie) => anomalie.statut === "a_traiter");
  const acquittees = anomalies.filter((anomalie) => anomalie.statut === "acquittee");
  const liste = vue === "a_traiter" ? aTraiter : acquittees;

  const fermerFormulaire = (restaurerFocusId?: string) => {
    setFormulaireOuvert(null);
    setJustification("");
    setErreur(null);
    if (restaurerFocusId) {
      requestAnimationFrame(() => document.getElementById(restaurerFocusId)?.focus());
    }
  };

  const verifier = async (event: FormEvent<HTMLFormElement>, anomalie: (typeof anomalies)[number]) => {
    event.preventDefault();
    const texte = justification.trim();
    if (!texte) {
      setErreur("Indiquez le motif du masquage manuel de cet écart.");
      return;
    }
    setActionEnCours(anomalie.id);
    setErreur(null);
    setAnnonce("");
    try {
      await acquitterAnomalie({ scrapId: anomalie.id, code_anomalie: anomalie.code_anomalie, justification: texte });
      setFormulaireOuvert(null);
      setJustification("");
      setAnnonce("Anomalie masquée manuellement de la liste À traiter.");
      requestAnimationFrame(() => boutonATraiterRef.current?.focus());
    } catch (error) {
      setErreur(aboError(error).message);
    } finally {
      setActionEnCours(null);
    }
  };

  const reactiver = async (anomalie: (typeof anomalies)[number]) => {
    if (!anomalie.acquittement) return;
    setActionEnCours(anomalie.id);
    setErreur(null);
    setAnnonce("");
    try {
      await reactiverAnomalie({ acquittementId: anomalie.acquittement.id });
      setAnnonce("Anomalie réaffichée dans la liste À traiter.");
      requestAnimationFrame(() => boutonMasqueesRef.current?.focus());
    } catch (error) {
      setErreur(aboError(error).message);
    } finally {
      setActionEnCours(null);
    }
  };

  return (
    <div className="abo-admin-section">
      <p className="abo-admin-intro">
        Sont listées uniquement les inscriptions du site du club dont « Abonnement valide ? » vaut Oui, Non ou l'ancien statut Inconnu à resynchroniser. Les inscriptions déjà marquées Bloqué sont exclues.
      </p>
      <ul className="abo-admin-rules-list" aria-label="Comment lire les anomalies">
        <li><strong>Règle 1 :</strong> la personne n'était pas abonnée l'année dernière et aucune demande n'a été déposée sur le portail.</li>
        <li><strong>Règle 2 :</strong> la personne n'était pas abonnée l'année dernière et la demande portail n'est pas validée.</li>
        <li>Une correspondance N-1 ambiguë doit être vérifiée manuellement : elle n'est jamais assimilée à « Non ».</li>
        <li>Le portail reste en lecture seule vis-à-vis du site : toute correction de l'inscription se fait sur le site du club, puis une synchronisation actualise cette liste.</li>
      </ul>

      <div className="abo-admin-anomaly-notice">
        <strong>Le masquage retire seulement l'écart de la liste À traiter.</strong>
        <span>Les données source restent inchangées : cela ne valide ni le dossier sur le portail, ni l'inscription sur le site du club.</span>
      </div>

      <div className="abo-admin-anomaly-tabs" role="group" aria-label="Filtrer les anomalies">
        <button ref={boutonATraiterRef} type="button" className="abo-admin-tab" aria-pressed={vue === "a_traiter"} onClick={() => { setVue("a_traiter"); fermerFormulaire(); }}>
          À traiter <span className="abo-admin-anomaly-tab-count">{aTraiter.length}</span>
        </button>
        <button ref={boutonMasqueesRef} type="button" className="abo-admin-tab" aria-pressed={vue === "acquittee"} onClick={() => { setVue("acquittee"); fermerFormulaire(); }}>
          Masquées manuellement <span className="abo-admin-anomaly-tab-count">{acquittees.length}</span>
        </button>
      </div>

      <p className="abo-admin-visually-hidden" role="status" aria-live="polite">{annonce}</p>
      {erreur && formulaireOuvert === null && <p className="abo-admin-anomaly-error" role="alert">{erreur}</p>}

      <section className="abo-admin-anomaly-region" aria-label={vue === "a_traiter" ? "Anomalies à traiter" : "Anomalies masquées manuellement"}>
        <p className="abo-admin-count">
          {liste.length} {vue === "a_traiter" ? "anomalie à traiter" : "anomalie masquée manuellement"}{liste.length > 1 ? "s" : ""}
        </p>

        {liste.length === 0 ? (
          <p className="abo-admin-empty">
            {vue === "a_traiter" ? "Aucune anomalie à traiter : les écarts restants sont masqués manuellement ou les inscriptions respectent les règles." : "Aucune anomalie n'a encore été masquée manuellement."}
          </p>
        ) : (
          <ul className="abo-admin-list">
            {liste.map((r) => {
              const nom = ((r.prenom ?? "").trim() + " " + (r.nom ?? "").trim()).trim() || r.nom_prenom_normalise || "—";
              const formulaireActif = formulaireOuvert === r.id;
              const pending = actionEnCours === r.id;
              const explicationLicenceId = `anomalie-licence-${r.id}`;
              return (
                <li key={r.id} className={`abo-admin-card abo-admin-anomaly ${r.statut === "a_traiter" ? "abo-admin-card--attention" : "abo-admin-anomaly--verified"}`}>
                  <div className="abo-admin-card-copy">
                    <div className="abo-admin-anomaly-heading">
                      <div><strong>{nom}</strong><span className="abo-admin-meta">Licence : {r.licence || "—"}</span></div>
                      {r.statut === "acquittee" && <span className="abo-admin-anomaly-state">Masquée manuellement</span>}
                    </div>
                    <p className="abo-admin-reason">{r.raison}</p>
                    <dl className="abo-admin-anomaly-checks">
                      <StatutInscriptionSite valeur={r.abonnement_valide} />
                      <ControleAbonnementN1 abonne={r.controles.abonneN1} ambigu={r.controles.abonneN1Ambigu} />
                      <ControleTexte label="Statut du dossier portail" valeur={r.controles.statutDossier} />
                    </dl>
                  </div>

                  {r.statut === "acquittee" && r.acquittement ? (
                    <div className="abo-admin-anomaly-resolution">
                      <div>
                        <strong>Motif du masquage</strong>
                        <p>{r.acquittement.justification}</p>
                        <time dateTime={r.acquittement.acquittee_le}>Masquée manuellement le {formatDateHeure(r.acquittement.acquittee_le)}</time>
                      </div>
                      <button type="button" className="abo-admin-button" disabled={actionEnCours !== null} onClick={() => void reactiver(r)}>
                        {pending ? "Réaffichage…" : "Réafficher dans À traiter"}
                      </button>
                    </div>
                  ) : formulaireActif ? (
                    <form className="abo-admin-anomaly-form" onSubmit={(event) => void verifier(event, r)}>
                      <label htmlFor={`justification-${r.id}`}>Motif du masquage</label>
                      <textarea id={`justification-${r.id}`} className="abo-admin-field abo-admin-anomaly-textarea" value={justification} maxLength={500} rows={4} autoFocus required disabled={pending} aria-describedby={`justification-aide-${r.id}`} onChange={(event) => setJustification(event.target.value)} />
                      <div id={`justification-aide-${r.id}`} className="abo-admin-anomaly-form-help">
                        <span>Ce motif sera conservé. Les données source restent inchangées.</span>
                        <span>{justification.length}/500</span>
                      </div>
                      {erreur && <p className="abo-admin-anomaly-error" role="alert">{erreur}</p>}
                      <div className="abo-admin-anomaly-actions">
                        <button type="submit" className="abo-admin-button abo-admin-button--primary" disabled={actionEnCours !== null || justification.trim().length === 0}>{pending ? "Masquage…" : "Masquer après contrôle"}</button>
                        <button type="button" className="abo-admin-button" disabled={pending} onClick={() => fermerFormulaire(`masquer-anomalie-${r.id}`)}>Annuler</button>
                      </div>
                    </form>
                  ) : (
                    <div className="abo-admin-anomaly-action-row">
                      <button id={`masquer-anomalie-${r.id}`} type="button" className="abo-admin-button abo-admin-button--secondary" disabled={!r.peutEtreAcquittee || actionEnCours !== null} aria-describedby={!r.peutEtreAcquittee ? explicationLicenceId : undefined} onClick={() => { setFormulaireOuvert(r.id); setJustification(""); setErreur(null); }}>Masquer après contrôle</button>
                      {!r.peutEtreAcquittee && <p id={explicationLicenceId} className="abo-admin-anomaly-disabled-help">Impossible à masquer tant qu'une licence valide n'est pas renseignée.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ControleAbonnementN1({ abonne, ambigu }: { abonne: boolean; ambigu: boolean }) {
  const texte = ambigu ? "Ambigu / à vérifier" : abonne ? "Oui" : "Non";
  return <div><dt>Abonné N-1</dt><dd>{texte}</dd></div>;
}

function ControleTexte({ label, valeur }: { label: string; valeur: string }) {
  const texte = valeur === "nouvelle_demande" ? "Nouvelle demande" : valeur === "liste_attente" ? "Liste d'attente" : valeur === "refusee" ? "Refusée" : valeur === "validee" ? "Validée" : valeur === "complete" ? "Complète" : "Inconnu";
  return <div><dt>{label}</dt><dd>{texte}</dd></div>;
}

function StatutInscriptionSite({ valeur }: { valeur: boolean | "oui" | "non" | "bloque" | "inconnu" }) {
  const statut = valeur === true ? "oui" : valeur === false ? "inconnu" : valeur;
  const texte = statut === "oui" ? "Oui" : statut === "non" ? "Non" : statut === "bloque" ? "Bloqué" : "À resynchroniser";
  const explication = statut === "oui" ? "Le site du club considère l'abonnement comme valide." : statut === "non" ? "Le site du club ne considère pas encore l'abonnement comme valide." : statut === "bloque" ? "Le site du club a bloqué l'inscription ; elle ne doit plus apparaître dans les anomalies après synchronisation." : "Cette ancienne valeur ne distingue pas Non de Bloqué. Une synchronisation du site est nécessaire.";
  return <div className={`abo-admin-site-status abo-admin-site-status--${statut}`}><dt>Inscription sur le site du club</dt><dd><strong>Abonnement valide ? {texte}</strong><span>{explication}</span></dd></div>;
}
