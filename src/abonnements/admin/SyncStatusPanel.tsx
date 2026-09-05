import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api";
import { useMaintenantMinute } from "../lib/useMaintenantMinute";
import { actualiserStatutSource } from "../../../convex/abo/syncStatus";

const SOURCES = [
  {
    id: "helloasso",
    label: "HelloAsso",
    detail: "Paiements et inscriptions",
    manualMode: "Bouton dans l’onglet Paiements",
  },
  {
    id: "scrap",
    label: "Site du club",
    detail: "Données des abonnés",
    manualMode: "Bouton dans l’onglet Dossiers",
  },
  {
    id: "annuaire",
    label: "Annuaire",
    detail: "Licences fédérales",
    manualMode: "Bouton dans l’onglet Licences",
  },
  {
    id: "eleves",
    label: "Élèves",
    detail: "Élèves des cours",
    manualMode: "Incluse dans le bouton Site club de l’onglet Dossiers",
  },
] as const;

type SourceId = (typeof SOURCES)[number]["id"];
type ResultatSync = "done" | "skipped" | "desactive" | "erreur";
type ResultatsSync = Record<SourceId, ResultatSync>;

const FORMAT_DATE = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Paris",
});

const LIBELLES_RESULTAT: Record<ResultatSync, string> = {
  done: "Mise à jour réussie",
  skipped: "Aucun appel disponible pour le moment",
  desactive: "Désactivée",
  erreur: "Échec",
};

function formaterDate(dateIso: string) {
  return FORMAT_DATE.format(new Date(dateIso));
}

function formaterDuree(dureeMs: number) {
  const minutes = Math.round(dureeMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const heures = minutes / 60;
  return Number.isInteger(heures) ? `${heures} h` : `${heures.toLocaleString("fr-FR")} h`;
}

function messageErreur(error: unknown) {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
      return data.message;
    }
  }
  return "La vérification n’a pas pu aboutir. Vous pouvez réessayer.";
}

function resumerResultats(resultats: ResultatsSync) {
  const valeurs = Object.values(resultats);
  const reussites = valeurs.filter((resultat) => resultat === "done").length;
  const echecs = valeurs.filter((resultat) => resultat === "erreur").length;
  const ignores = valeurs.filter(
    (resultat) => resultat === "skipped" || resultat === "desactive",
  ).length;

  if (echecs > 0) {
    return `Vérification terminée avec un succès partiel : ${reussites} source${reussites > 1 ? "s" : ""} mise${reussites > 1 ? "s" : ""} à jour, ${echecs} en échec et ${ignores} sans changement.`;
  }
  if (reussites === 0) {
    return "Vérification terminée : aucune source disponible pour un nouvel appel ou sources désactivées.";
  }
  return `Vérification terminée : ${reussites} source${reussites > 1 ? "s ont" : " a"} été mise${reussites > 1 ? "s" : ""} à jour.`;
}

export default function SyncStatusPanel() {
  const maintenantMs = useMaintenantMinute();
  const etatSources = useQuery(api.abo.sync.getStatutSyncAbo, {});
  const statut = etatSources === undefined ? undefined : {
    helloasso: actualiserStatutSource("helloasso", etatSources.helloasso, maintenantMs),
    scrap: actualiserStatutSource("scrap", etatSources.scrap, maintenantMs),
    annuaire: actualiserStatutSource("annuaire", etatSources.annuaire, maintenantMs),
    eleves: actualiserStatutSource("eleves", etatSources.eleves, maintenantMs),
  };
  const syncAbo = useAction(api.abo.sync.syncPourAbo);
  const verificationAutomatiqueLancee = useRef(false);
  const [enCours, setEnCours] = useState(false);
  const [resultats, setResultats] = useState<ResultatsSync | null>(null);
  const [annonce, setAnnonce] = useState(
    "Préparation de la vérification automatique des synchronisations.",
  );
  const [erreur, setErreur] = useState<string | null>(null);

  const lancerVerification = useCallback(async () => {
    setEnCours(true);
    setErreur(null);
    setResultats(null);
    setAnnonce(
      "Vérification en cours : HelloAsso, puis le site du club, l’annuaire et les élèves.",
    );

    try {
      const nouveauxResultats = await syncAbo({});
      setResultats(nouveauxResultats);
      setAnnonce(resumerResultats(nouveauxResultats));
    } catch (error) {
      const detail = messageErreur(error);
      setErreur(detail);
      setAnnonce(`Échec de la vérification : ${detail}`);
    } finally {
      setEnCours(false);
    }
  }, [syncAbo]);

  useEffect(() => {
    if (verificationAutomatiqueLancee.current) return;
    verificationAutomatiqueLancee.current = true;
    void lancerVerification();
  }, [lancerVerification]);

  const sourceDisponible = statut
    ? Object.values(statut).some((source) => source.active && source.nextSyncAt === null)
    : false;
  const resultatAvecErreur = resultats
    ? Object.values(resultats).some((resultat) => resultat === "erreur")
    : false;
  const boutonDesactive = enCours || statut === undefined || !sourceDisponible;

  return (
    <section
      className="abo-admin-sync-panel"
      aria-labelledby="abo-sync-panel-title"
      aria-busy={enCours}
    >
      <div className="abo-admin-sync-panel-head">
        <div>
          <p className="abo-admin-sync-panel-kicker">
            Sources d’inscription · hors règlements Drive
          </p>
          <h2 id="abo-sync-panel-title">État des synchronisations</h2>
          <p className="abo-admin-sync-panel-intro">
            La vérification se lance automatiquement à l’ouverture. Chaque source n’est mise à jour
            que lorsqu’elle est disponible. Pour l’annuaire, les créneaux s’ouvrent à 7 h et 9 h,
            heure de Paris. Sans consultation, aucun appel à l’annuaire n’est lancé.
          </p>
        </div>
        <button
          className="abo-admin-button abo-admin-button--primary abo-admin-sync-panel-button"
          type="button"
          onClick={() => void lancerVerification()}
          disabled={boutonDesactive}
          aria-describedby="abo-sync-panel-button-note"
        >
          {enCours ? "Actualisation en cours…" : "Actualiser les sources disponibles"}
        </button>
      </div>

      <p
        className={`abo-admin-sync-panel-annonce${
          erreur
            ? " abo-admin-sync-panel-annonce--error"
            : resultatAvecErreur
              ? " abo-admin-sync-panel-annonce--warning"
              : ""
        }`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {annonce}
      </p>

      <div className="abo-admin-sync-panel-grid">
        {SOURCES.map((source, index) => {
          const etat = statut?.[source.id];
          const resultat = resultats?.[source.id];
          const disponible = etat?.active === true && etat.nextSyncAt === null;

          return (
            <article
              className={`abo-admin-sync-panel-card${etat && !etat.active ? " is-disabled" : ""}`}
              key={source.id}
            >
              <div className="abo-admin-sync-panel-source">
                <span className="abo-admin-sync-panel-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{source.label}</h3>
                  <p>{source.detail}</p>
                </div>
              </div>

              {etat === undefined ? (
                <p className="abo-admin-sync-panel-loading">Chargement de l’état…</p>
              ) : (
                <>
                  <dl className="abo-admin-sync-panel-data">
                    <div>
                      {enCours && etat.active ? (
                        <>
                          <dt>État courant</dt>
                          <dd>
                            <span className="abo-admin-sync-panel-state is-running">
                              Synchronisation en cours
                            </span>
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt>Dernière réussite</dt>
                          <dd>
                            {etat.lastSyncAt ? (
                              <time dateTime={etat.lastSyncAt}>
                                {formaterDate(etat.lastSyncAt)}
                              </time>
                            ) : (
                              "Jamais synchronisée"
                            )}
                          </dd>
                        </>
                      )}
                    </div>
                    <div>
                      <dt>Disponible à la prochaine consultation</dt>
                      <dd>
                        {!etat.active ? (
                          <span className="abo-admin-sync-panel-state is-disabled">
                            Suspendue pour changement de campagne — réactivation dans Configuration
                          </span>
                        ) : disponible ? (
                          <span className="abo-admin-sync-panel-state is-ready">
                            Disponible maintenant
                          </span>
                        ) : etat.nextSyncAt ? (
                          <time dateTime={etat.nextSyncAt}>{formaterDate(etat.nextSyncAt)}</time>
                        ) : (
                          "Disponible maintenant"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{source.id === "annuaire" ? "Créneaux quotidiens" : "Délai minimal automatique"}</dt>
                      <dd>{source.id === "annuaire"
                        ? "À partir de 7 h et 9 h · heure de Paris"
                        : formaterDuree(etat.minimumIntervalMs)}</dd>
                    </div>
                  </dl>

                  <div className="abo-admin-sync-panel-manual">
                    <h4>Actualisation manuelle</h4>
                    <p>{source.manualMode}</p>
                    <dl>
                      <div>
                        <dt>Prochaine disponibilité manuelle</dt>
                        <dd>
                          {!etat.active ? (
                            "Suspendue avec la source"
                          ) : etat.manualNextSyncAt ? (
                            <time dateTime={etat.manualNextSyncAt}>
                              {formaterDate(etat.manualNextSyncAt)}
                            </time>
                          ) : (
                            "Disponible maintenant"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{source.id === "annuaire" ? "Limite partagée" : "Délai manuel"}</dt>
                        <dd>
                          {source.id === "annuaire"
                            ? "Mêmes créneaux · 2 tentatives maximum par jour, même en cas d’échec"
                            : etat.manualIntervalMs === null
                            ? "Non proposé"
                            : formaterDuree(etat.manualIntervalMs)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </>
              )}

              {resultat && (
                <p className={`abo-admin-sync-panel-result is-${resultat}`}>
                  Dernière vérification : {LIBELLES_RESULTAT[resultat]}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <p className="abo-admin-sync-panel-note" id="abo-sync-panel-button-note">
        {!enCours && statut !== undefined && !sourceDisponible
          ? "Aucune source n’est disponible pour l’actualisation automatique actuellement. "
          : "Le bouton actualise uniquement les sources disponibles. "}
        Pour l’annuaire, une première consultation après 9 h lance un seul appel, sans rattrapage.
        Les autres sources conservent leurs propres délais. Toutes les heures affichées sont celles de Paris.
      </p>
    </section>
  );
}
