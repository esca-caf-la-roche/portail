import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";

type StatutReglement = "a_enregistrer" | "enregistre";

type RechercheAnnuaire = {
  nom: string;
  prenom: string;
};

type CandidatReglement = {
  licence: string;
  nom: string;
  prenom: string;
  correspondance: "exacte" | "approchee";
};

type Reglement = NonNullable<
  ReturnType<typeof usePaginatedQuery<typeof api.abo.reglements.lister>>["results"]
>[number];

type ImportReglement = NonNullable<
  ReturnType<typeof usePaginatedQuery<typeof api.abo.reglementsImports.listerARapprocher>>["results"]
>[number];

const TAILLE_PAGE_REGLEMENTS = 25;

export default function Reglements() {
  const synchroniser = useAction(api.abo.reglementsWebhook.synchroniser);
  const synchronisationInitialeLancee = useRef(false);
  const [synchronisationEnCours, setSynchronisationEnCours] = useState(false);
  const [messageSynchronisation, setMessageSynchronisation] = useState<string | null>(null);
  const [erreurSynchronisation, setErreurSynchronisation] = useState<string | null>(null);

  const synchroniserReglements = useCallback(async () => {
    setSynchronisationEnCours(true);
    setMessageSynchronisation(null);
    setErreurSynchronisation(null);
    try {
      const resultat = await synchroniser({});
      setMessageSynchronisation(
        `${resultat.recus} reçu${resultat.recus === 1 ? "" : "s"} · ${resultat.crees} ajouté${resultat.crees === 1 ? "" : "s"} · ${resultat.actualises} actualisé${resultat.actualises === 1 ? "" : "s"} · ${resultat.ignores} ignoré${resultat.ignores === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setErreurSynchronisation(aboError(err).message);
    } finally {
      setSynchronisationEnCours(false);
    }
  }, [synchroniser]);

  useEffect(() => {
    if (synchronisationInitialeLancee.current) return;
    synchronisationInitialeLancee.current = true;
    void synchroniserReglements();
  }, [synchroniserReglements]);

  return (
    <div className="abo-admin-section">
      <div>
        <h2>Règlements signés</h2>
        <p className="abo-admin-intro">
          Synchronisez les règlements disponibles dans Drive, puis vérifiez leur
          identité et associez-les à la bonne licence.
        </p>
      </div>

      <div className="abo-admin-toolbar">
        <button
          type="button"
          className="abo-admin-button abo-admin-button--secondary"
          disabled={synchronisationEnCours}
          onClick={() => void synchroniserReglements()}
        >
          {synchronisationEnCours ? "Synchronisation…" : "Synchroniser les règlements"}
        </button>
      </div>
      {messageSynchronisation ? (
        <p className="abo-admin-status abo-admin-status--success" role="status">
          {messageSynchronisation}
        </p>
      ) : null}
      {erreurSynchronisation ? (
        <p className="abo-admin-status abo-admin-status--error" role="alert">
          Échec : {erreurSynchronisation}
        </p>
      ) : null}

      <ImportsARapprocher />

      <hr className="abo-admin-separator" />

      <FileReglements />

    </div>
  );
}

function ImportsARapprocher() {
  const {
    results: imports,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.abo.reglementsImports.listerARapprocher,
    {},
    { initialNumItems: TAILLE_PAGE_REGLEMENTS },
  );

  return (
    <section className="abo-admin-tests-step">
      <div>
        <h3 className="abo-admin-subheading">Nouveaux règlements à rapprocher</h3>
        <p className="abo-admin-meta">
          Vérifiez le PDF et l&apos;identité extraite, puis choisissez la bonne
          licence. La liaison reste toujours confirmée par un membre du staff.
        </p>
      </div>

      {status === "LoadingFirstPage" ? (
        <p>Chargement des nouveaux règlements…</p>
      ) : imports.length === 0 ? (
        <p className="abo-admin-empty">Aucun nouveau règlement à rapprocher.</p>
      ) : (
        <>
          <ul className="abo-admin-list">
            {imports.map((reglementImport) => (
              <ImportARapprocher key={reglementImport.id} reglementImport={reglementImport} />
            ))}
          </ul>
          {status === "CanLoadMore" || status === "LoadingMore" ? (
            <button
              type="button"
              className="abo-admin-button abo-admin-button--secondary"
              disabled={status === "LoadingMore"}
              onClick={() => loadMore(TAILLE_PAGE_REGLEMENTS)}
            >
              {status === "LoadingMore" ? "Chargement…" : "Charger plus"}
            </button>
          ) : null}
          {status === "Exhausted" ? (
            <p className="abo-admin-meta" role="status">
              Tous les nouveaux règlements sont affichés.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ImportARapprocher({ reglementImport }: { reglementImport: ImportReglement }) {
  const candidats = reglementImport.candidats as CandidatReglement[];
  const confirmer = useAction(api.abo.reglementsDrive.lierImportALicence);
  const [licenceSelectionnee, setLicenceSelectionnee] = useState<string | null>(null);
  const [nomManuel, setNomManuel] = useState("");
  const [prenomManuel, setPrenomManuel] = useState("");
  const [rechercheManuelle, setRechercheManuelle] = useState<RechercheAnnuaire | null>(null);
  const candidatsManuels = useQuery(
    api.abo.reglements.rechercherLicencesParNom,
    rechercheManuelle ?? "skip",
  );
  const [confirmationEnCours, setConfirmationEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function confirmerCandidat() {
    if (!licenceSelectionnee) return;
    const candidat =
      candidats?.find((item) => item.licence === licenceSelectionnee) ??
      candidatsManuels?.find((item) => item.licence === licenceSelectionnee);
    if (!candidat) return;
    if (
      !window.confirm(
        `Confirmer la liaison du règlement « ${reglementImport.identiteExtraite} » avec ${candidat.prenom} ${candidat.nom}, licence ${candidat.licence} ?`,
      )
    ) {
      return;
    }

    setConfirmationEnCours(true);
    setErreur(null);
    try {
      await confirmer({ importId: reglementImport.id, licence: candidat.licence });
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setConfirmationEnCours(false);
    }
  }

  return (
    <li className="abo-admin-card abo-admin-reglement-import">
      <div className="abo-admin-reglement-import-header">
        <div>
          <strong>{reglementImport.identiteExtraite || "Identité non reconnue"}</strong>
          <p className="abo-admin-meta">
            Synchronisé le {new Date(reglementImport.importeLe).toLocaleString("fr-FR")}
          </p>
        </div>
        <a
          className="abo-admin-link-button"
          href={reglementImport.pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Ouvrir dans Drive
        </a>
      </div>

      {candidats.length === 0 ? (
        <p className="abo-admin-empty">
          Aucun licencié probable trouvé. Vérifiez l&apos;identité extraite ou utilisez
          l&apos;onglet Historique GDrive.
        </p>
      ) : (
        <fieldset className="abo-admin-reglement-fieldset">
          <legend>Choisir le licencié</legend>
          <ul className="abo-admin-list">
            {candidats.map((candidat) => (
              <li key={candidat.licence} className="abo-admin-list-row">
                <label className="abo-admin-reglement-choice">
                  <input
                    type="radio"
                    name={`licence-import-${reglementImport.id}`}
                    checked={licenceSelectionnee === candidat.licence}
                    disabled={confirmationEnCours}
                    onChange={() => setLicenceSelectionnee(candidat.licence)}
                  />
                  <span>
                    <strong>{`${candidat.prenom} ${candidat.nom}`.trim()}</strong>{" "}
                    <span className="abo-admin-meta">Licence {candidat.licence}</span>{" "}
                    <span
                      className={`abo-admin-badge abo-admin-reglement-correspondance abo-admin-reglement-correspondance--${candidat.correspondance}`}
                    >
                      {candidat.correspondance === "exacte"
                        ? "Correspondance exacte"
                        : "Correspondance probable"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <div className="abo-admin-reglement-search">
        <p className="abo-admin-meta">
          Si la bonne personne n&apos;est pas proposée, recherchez-la avec un nom,
          un prénom ou seulement un fragment.
        </p>
        <div className="abo-admin-toolbar abo-admin-reglement-search">
          <label className="abo-admin-filter-field">
            <span>Nom</span>
            <input
              className="abo-admin-input"
              value={nomManuel}
              onChange={(event) => setNomManuel(event.target.value)}
              placeholder="Nom ou fragment"
            />
          </label>
          <label className="abo-admin-filter-field">
            <span>Prénom</span>
            <input
              className="abo-admin-input"
              value={prenomManuel}
              onChange={(event) => setPrenomManuel(event.target.value)}
              placeholder="Prénom ou fragment"
            />
          </label>
          <button
            type="button"
            className="abo-admin-button abo-admin-button--secondary"
            disabled={!nomManuel.trim() && !prenomManuel.trim()}
            onClick={() =>
              setRechercheManuelle({ nom: nomManuel.trim(), prenom: prenomManuel.trim() })
            }
          >
            Rechercher dans l&apos;annuaire
          </button>
        </div>
        {candidatsManuels && candidatsManuels.length > 0 ? (
          <fieldset className="abo-admin-reglement-fieldset">
            <legend>Résultats de la recherche</legend>
            <ul className="abo-admin-list">
              {candidatsManuels.map((candidat) => (
                <li key={candidat.licence} className="abo-admin-list-row">
                  <label className="abo-admin-reglement-choice">
                    <input
                      type="radio"
                      name={`licence-import-${reglementImport.id}`}
                      checked={licenceSelectionnee === candidat.licence}
                      disabled={confirmationEnCours}
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
        ) : rechercheManuelle && candidatsManuels?.length === 0 ? (
          <p className="abo-admin-empty">Aucune licence trouvée avec cette recherche.</p>
        ) : null}
      </div>

      {licenceSelectionnee ? (
        <button
          type="button"
          className="abo-admin-button abo-admin-button--primary"
          disabled={confirmationEnCours}
          onClick={() => void confirmerCandidat()}
        >
          {confirmationEnCours ? "Confirmation…" : "Confirmer cette licence"}
        </button>
      ) : null}
      {erreur ? (
        <p className="abo-admin-status abo-admin-status--error" role="alert">
          Échec : {erreur}
        </p>
      ) : null}
    </li>
  );
}

function FileReglements() {
  const [statut, setStatut] = useState<StatutReglement>("a_enregistrer");
  const {
    results: reglements,
    status: statutPagination,
    loadMore,
  } = usePaginatedQuery(
    api.abo.reglements.lister,
    { statut },
    { initialNumItems: TAILLE_PAGE_REGLEMENTS },
  );
  const marquerEnregistre = useMutation(api.abo.reglements.marquerEnregistreSite);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  async function marquer(reglement: Reglement) {
    if (
      !window.confirm(
        `Confirmer que le règlement de ${reglement.prenom} ${reglement.nom} a été enregistré sur le site du club ?`,
      )
    ) {
      return;
    }
    setEnCours(reglement.id);
    setErreur(null);
    try {
      await marquerEnregistre({ reglementId: reglement.id });
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setEnCours(null);
    }
  }

  return (
    <section className="abo-admin-tests-step">
      <div>
        <h3 className="abo-admin-subheading">Règlements liés</h3>
        <p className="abo-admin-meta">
          Ouvrez le PDF Drive, enregistrez le règlement sur le site du club, puis
          confirmez ici que l&apos;opération est faite.
        </p>
      </div>
      <div className="abo-admin-toolbar abo-admin-tests-filter-tabs" role="group" aria-label="Filtrer les règlements">
        <button
          type="button"
          className="abo-admin-button"
          aria-pressed={statut === "a_enregistrer"}
          onClick={() => setStatut("a_enregistrer")}
        >
          À enregistrer
        </button>
        <button
          type="button"
          className="abo-admin-button"
          aria-pressed={statut === "enregistre"}
          onClick={() => setStatut("enregistre")}
        >
          Enregistrés
        </button>
      </div>

      {erreur ? <p className="abo-admin-status abo-admin-status--error" role="alert">Échec : {erreur}</p> : null}
      {statutPagination === "LoadingFirstPage" ? (
        <p>Chargement…</p>
      ) : reglements.length === 0 ? (
        <p className="abo-admin-empty">
          {statut === "a_enregistrer"
            ? "Aucun règlement en attente d'enregistrement sur le site du club."
            : "Aucun règlement déjà enregistré."}
        </p>
      ) : (
        <>
          <ul className="abo-admin-list">
            {reglements.map((reglement) => (
              <li key={reglement.id} className="abo-admin-card abo-admin-reglement-card">
                <div>
                  <strong>{`${reglement.prenom} ${reglement.nom}`.trim()}</strong>{" "}
                  <span className="abo-admin-meta">Licence {reglement.licence}</span>
                  <p className="abo-admin-meta">{reglement.nomFichier}</p>
                </div>
                <div className="abo-admin-toolbar">
                  <a
                    className="abo-admin-link-button"
                    href={reglement.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Ouvrir le règlement dans Drive
                  </a>
                  {reglement.statut === "a_enregistrer" ? (
                    <button
                      type="button"
                      className="abo-admin-button abo-admin-button--primary"
                      disabled={enCours === reglement.id}
                      onClick={() => void marquer(reglement)}
                    >
                      {enCours === reglement.id ? "Enregistrement…" : "Marquer enregistré sur le site"}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {statutPagination === "CanLoadMore" || statutPagination === "LoadingMore" ? (
            <button
              type="button"
              className="abo-admin-button abo-admin-button--secondary"
              disabled={statutPagination === "LoadingMore"}
              onClick={() => loadMore(TAILLE_PAGE_REGLEMENTS)}
            >
              {statutPagination === "LoadingMore" ? "Chargement…" : "Charger plus"}
            </button>
          ) : null}
          {statutPagination === "Exhausted" ? (
            <p className="abo-admin-meta" role="status">
              Tous les règlements de cette file sont affichés.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
