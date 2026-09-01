import { useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";

type FichierTest = {
  nomFichier: string;
  driveUrl: string;
};

type FichierReglement = FichierTest & {
  driveFileId: string;
};

type RechercheAnnuaire = {
  nom: string;
  prenom: string;
};

export default function HistoriqueDrive() {
  const rechercherTests = useAction(api.abo.testDocumentsDrive.rechercherDansDrive);
  const rechercherReglements = useAction(api.abo.reglementsDrive.rechercherDansDrive);
  const [nom, setNom] = useState("");
  const [prenom, setPrenom] = useState("");
  const [tests, setTests] = useState<FichierTest[]>([]);
  const [reglements, setReglements] = useState<FichierReglement[]>([]);
  const [erreurTests, setErreurTests] = useState<string | null>(null);
  const [erreurReglements, setErreurReglements] = useState<string | null>(null);
  const [rechercheLancee, setRechercheLancee] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [reglementSelectionne, setReglementSelectionne] = useState<FichierReglement | null>(null);
  const numeroRecherche = useRef(0);

  function invaliderResultats() {
    numeroRecherche.current += 1;
    setEnCours(false);
    setRechercheLancee(false);
    setTests([]);
    setReglements([]);
    setErreurTests(null);
    setErreurReglements(null);
    setReglementSelectionne(null);
  }

  async function rechercher(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nomRecherche = nom.trim();
    const prenomRecherche = prenom.trim();
    if (!nomRecherche && !prenomRecherche) return;

    const rechercheId = numeroRecherche.current + 1;
    numeroRecherche.current = rechercheId;
    setEnCours(true);
    setRechercheLancee(true);
    setTests([]);
    setReglements([]);
    setErreurTests(null);
    setErreurReglements(null);
    setReglementSelectionne(null);

    const [resultatTests, resultatReglements] = await Promise.allSettled([
      rechercherTests({ nom: nomRecherche, prenom: prenomRecherche }),
      rechercherReglements({ nom: nomRecherche, prenom: prenomRecherche }),
    ]);
    if (rechercheId !== numeroRecherche.current) return;

    if (resultatTests.status === "fulfilled") {
      setTests(resultatTests.value);
    } else {
      setErreurTests(aboError(resultatTests.reason).message);
    }
    if (resultatReglements.status === "fulfilled") {
      setReglements(resultatReglements.value);
    } else {
      setErreurReglements(aboError(resultatReglements.reason).message);
    }
    setEnCours(false);
  }

  return (
    <div className="abo-admin-section abo-admin-drive-history">
      <div>
        <p className="abo-admin-drive-kicker">Archives du club</p>
        <h2>Historique GDrive</h2>
        <p className="abo-admin-intro">
          Une seule recherche parcourt les anciens tests d&apos;autonomie et les
          règlements signés. Saisissez au moins un nom ou un prénom.
        </p>
      </div>

      <form className="abo-admin-toolbar abo-admin-drive-search" onSubmit={rechercher}>
        <label className="abo-admin-filter-field" htmlFor="historique-drive-nom">
          <span>Nom</span>
          <input
            id="historique-drive-nom"
            className="abo-admin-input"
            autoComplete="family-name"
            value={nom}
            disabled={enCours}
            onChange={(event) => {
              setNom(event.target.value);
              invaliderResultats();
            }}
          />
        </label>
        <label className="abo-admin-filter-field" htmlFor="historique-drive-prenom">
          <span>Prénom</span>
          <input
            id="historique-drive-prenom"
            className="abo-admin-input"
            autoComplete="given-name"
            value={prenom}
            disabled={enCours}
            onChange={(event) => {
              setPrenom(event.target.value);
              invaliderResultats();
            }}
          />
        </label>
        <button
          type="submit"
          className="abo-admin-button abo-admin-button--secondary"
          disabled={enCours || (!nom.trim() && !prenom.trim())}
        >
          {enCours ? "Recherche dans Drive…" : "Rechercher les deux documents"}
        </button>
      </form>

      <p className="abo-admin-meta" aria-live="polite">
        {enCours
          ? "Recherche des tests et règlements en cours."
          : rechercheLancee
            ? `${tests.length} test${tests.length === 1 ? "" : "s"} · ${reglements.length} règlement${reglements.length === 1 ? "" : "s"}`
            : "Les résultats seront classés par type de document."}
      </p>

      {rechercheLancee && !enCours ? (
        <div className="abo-admin-drive-results">
          <ResultatsDrive
            titre="Tests d’autonomie"
            accent="tests"
            fichiers={tests}
            erreur={erreurTests}
            vide="Aucun ancien test d’autonomie trouvé pour cette recherche."
          />

          <section className="abo-admin-drive-group abo-admin-drive-group--reglements">
            <header className="abo-admin-drive-group-header">
              <h3>Règlements signés</h3>
              <span className="abo-admin-count">{reglements.length}</span>
            </header>
            {erreurReglements ? (
              <p className="abo-admin-status abo-admin-status--error" role="alert">
                Recherche des règlements indisponible : {erreurReglements}
              </p>
            ) : reglements.length === 0 ? (
              <p className="abo-admin-empty">Aucun règlement signé trouvé pour cette recherche.</p>
            ) : (
              <ul className="abo-admin-test-results">
                {reglements.map((fichier) => (
                  <li key={fichier.driveFileId} className="abo-admin-test-result">
                    <div className="abo-admin-drive-file">
                      <strong>{fichier.nomFichier}</strong>
                      <span className="abo-admin-meta">Règlement signé</span>
                    </div>
                    <div className="abo-admin-toolbar">
                      <a
                        className="abo-admin-link-button"
                        href={fichier.driveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Ouvrir dans Drive
                      </a>
                      <button
                        type="button"
                        className="abo-admin-button abo-admin-button--primary"
                        aria-pressed={reglementSelectionne?.driveFileId === fichier.driveFileId}
                        onClick={() =>
                          setReglementSelectionne((selection) =>
                            selection?.driveFileId === fichier.driveFileId ? null : fichier,
                          )
                        }
                      >
                        {reglementSelectionne?.driveFileId === fichier.driveFileId
                          ? "Annuler la liaison"
                          : "Lier à une licence"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {reglementSelectionne ? (
              <LiaisonReglement
                key={reglementSelectionne.driveFileId}
                fichier={reglementSelectionne}
                nomInitial={nom.trim()}
                prenomInitial={prenom.trim()}
                onLiaison={() => setReglementSelectionne(null)}
              />
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ResultatsDrive({
  titre,
  accent,
  fichiers,
  erreur,
  vide,
}: {
  titre: string;
  accent: "tests";
  fichiers: FichierTest[];
  erreur: string | null;
  vide: string;
}) {
  return (
    <section className={`abo-admin-drive-group abo-admin-drive-group--${accent}`}>
      <header className="abo-admin-drive-group-header">
        <h3>{titre}</h3>
        <span className="abo-admin-count">{fichiers.length}</span>
      </header>
      {erreur ? (
        <p className="abo-admin-status abo-admin-status--error" role="alert">
          Recherche des tests indisponible : {erreur}
        </p>
      ) : fichiers.length === 0 ? (
        <p className="abo-admin-empty">{vide}</p>
      ) : (
        <ul className="abo-admin-test-results">
          {fichiers.map((fichier) => (
            <li key={fichier.driveUrl} className="abo-admin-test-result">
              <div className="abo-admin-drive-file">
                <strong>{fichier.nomFichier}</strong>
                <span className="abo-admin-meta">Test d&apos;autonomie</span>
              </div>
              <a
                className="abo-admin-link-button"
                href={fichier.driveUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Ouvrir dans Drive
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LiaisonReglement({
  fichier,
  nomInitial,
  prenomInitial,
  onLiaison,
}: {
  fichier: FichierReglement;
  nomInitial: string;
  prenomInitial: string;
  onLiaison: () => void;
}) {
  const lierFichier = useAction(api.abo.reglementsDrive.lierFichierALicence);
  const [nom, setNom] = useState(nomInitial);
  const [prenom, setPrenom] = useState(prenomInitial);
  const [rechercheAnnuaire, setRechercheAnnuaire] = useState<RechercheAnnuaire | null>(null);
  const candidats = useQuery(
    api.abo.reglements.rechercherLicencesParNom,
    rechercheAnnuaire ?? "skip",
  );
  const [licenceSelectionnee, setLicenceSelectionnee] = useState<string | null>(null);
  const [liaisonEnCours, setLiaisonEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  function rechercherLicence(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!nom.trim() || !prenom.trim()) {
      setErreur("Renseignez le nom et le prénom complets pour rechercher la licence.");
      return;
    }
    setLicenceSelectionnee(null);
    setMessage(null);
    setErreur(null);
    setRechercheAnnuaire({ nom: nom.trim(), prenom: prenom.trim() });
  }

  async function confirmerLiaison() {
    if (!licenceSelectionnee) return;
    const candidat = candidats?.find((item) => item.licence === licenceSelectionnee);
    const identite = candidat
      ? `${candidat.prenom} ${candidat.nom}`.trim()
      : `la licence ${licenceSelectionnee}`;
    if (
      !window.confirm(
        `Confirmer la liaison de « ${fichier.nomFichier} » avec ${identite} (licence ${licenceSelectionnee}) ?`,
      )
    ) {
      return;
    }

    setLiaisonEnCours(true);
    setMessage(null);
    setErreur(null);
    try {
      await lierFichier({ driveFileId: fichier.driveFileId, licence: licenceSelectionnee });
      setMessage(`Règlement lié à la licence ${licenceSelectionnee}.`);
      setLicenceSelectionnee(null);
      setRechercheAnnuaire(null);
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setLiaisonEnCours(false);
    }
  }

  return (
    <div className="abo-admin-reglement-link-step abo-admin-drive-link-step">
      <div>
        <h4 className="abo-admin-subheading">Lier ce règlement à une licence</h4>
        <p className="abo-admin-meta">
          Fichier choisi : <strong>{fichier.nomFichier}</strong>. Confirmez l&apos;identité
          exacte avant de lancer la recherche dans l&apos;annuaire.
        </p>
      </div>
      <form className="abo-admin-toolbar abo-admin-reglement-search" onSubmit={rechercherLicence}>
        <label className="abo-admin-filter-field" htmlFor="historique-licence-nom">
          <span>Nom complet</span>
          <input
            id="historique-licence-nom"
            className="abo-admin-input"
            autoComplete="family-name"
            value={nom}
            disabled={liaisonEnCours}
            onChange={(event) => {
              setNom(event.target.value);
              setRechercheAnnuaire(null);
              setLicenceSelectionnee(null);
            }}
          />
        </label>
        <label className="abo-admin-filter-field" htmlFor="historique-licence-prenom">
          <span>Prénom complet</span>
          <input
            id="historique-licence-prenom"
            className="abo-admin-input"
            autoComplete="given-name"
            value={prenom}
            disabled={liaisonEnCours}
            onChange={(event) => {
              setPrenom(event.target.value);
              setRechercheAnnuaire(null);
              setLicenceSelectionnee(null);
            }}
          />
        </label>
        <button
          type="submit"
          className="abo-admin-button abo-admin-button--secondary"
          disabled={liaisonEnCours || !nom.trim() || !prenom.trim()}
        >
          Rechercher la licence
        </button>
      </form>

      {rechercheAnnuaire && candidats === undefined ? <p>Recherche dans l&apos;annuaire…</p> : null}
      {candidats?.length === 0 ? (
        <p className="abo-admin-empty">Aucune licence ne correspond à ce nom et ce prénom.</p>
      ) : null}
      {candidats && candidats.length > 0 ? (
        <fieldset className="abo-admin-reglement-fieldset">
          <legend>Choisir le licencié</legend>
          <ul className="abo-admin-list">
            {candidats.map((candidat) => (
              <li key={candidat.licence} className="abo-admin-list-row">
                <label className="abo-admin-reglement-choice">
                  <input
                    type="radio"
                    name={`licence-reglement-${fichier.driveFileId}`}
                    checked={licenceSelectionnee === candidat.licence}
                    disabled={liaisonEnCours}
                    onChange={() => setLicenceSelectionnee(candidat.licence)}
                  />
                  <span>
                    <strong>{`${candidat.prenom} ${candidat.nom}`.trim()}</strong>{" "}
                    <span className="abo-admin-meta">Licence {candidat.licence}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {licenceSelectionnee ? (
        <button
          type="button"
          className="abo-admin-button abo-admin-button--primary"
          disabled={liaisonEnCours}
          onClick={() => void confirmerLiaison()}
        >
          {liaisonEnCours ? "Liaison…" : "Confirmer la liaison avec cette licence"}
        </button>
      ) : null}
      {message ? (
        <div className="abo-admin-toolbar">
          <p className="abo-admin-status abo-admin-status--success" role="status">{message}</p>
          <button type="button" className="abo-admin-button" onClick={onLiaison}>
            Fermer
          </button>
        </div>
      ) : null}
      {erreur ? (
        <p className="abo-admin-status abo-admin-status--error" role="alert">Échec : {erreur}</p>
      ) : null}
    </div>
  );
}
