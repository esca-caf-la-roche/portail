import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import "../abo.css";
import Dossiers from "./Dossiers";
import Licences from "./Licences";
import Tests from "./Tests";
import Anomalies from "./Anomalies";
import Paiements from "./Paiements";
import Configuration from "./Configuration";
import Messages from "./Messages";
import Reglements from "./Reglements";

type Vue = "dossiers" | "messages" | "anomalies" | "licences" | "tests" | "reglements" | "paiements" | "config";

const TABS: { id: Vue; label: string }[] = [
  { id: "dossiers", label: "Dossiers" },
  { id: "messages", label: "Messages" },
  { id: "paiements", label: "Paiements" },
  { id: "anomalies", label: "Anomalies" },
  { id: "licences", label: "Licences" },
  { id: "tests", label: "Test Autonomie" },
  { id: "reglements", label: "Règlements" },
  { id: "config", label: "Configuration" },
];

// Espace admin des abonnements (dans le Layout compta, atteint par la tuile).
// Réservé au staff qui gère les abonnements (garde côté serveur + ici).
// Phase B : coquille à onglets ; les vues sont remplies aux phases suivantes.
export default function AboAdmin() {
  const me = useQuery(api.abo.identity.me);
  const messagesNonLus = useQuery(api.abo.messages.messagesNonLusAdmin);
  const testsATraiter = useQuery(api.abo.testDocuments.listArchives, {
    filtre: "a_traiter",
  });
  const reglementsATraiter = useQuery(api.abo.reglements.compterActions, {});
  const [vue, setVue] = useState<Vue>("dossiers");
  const [licenceTest, setLicenceTest] = useState<string | null>(null);

  const compteurs: Partial<Record<Vue, number>> = {
    messages: messagesNonLus?.reduce((total, message) => total + message.count, 0),
    tests: testsATraiter?.length,
    reglements: reglementsATraiter,
  };

  // Synchro on-demand au chargement (throttle serveur ~1 h) : remplace les crons
  // horaires. Non-bloquante — les vues lisent le cache et se rafraîchissent
  // toutes seules quand les données changent. Ordre géré côté serveur
  // (HelloAsso → scrap → annuaire → élèves).
  const syncAbo = useAction(api.abo.sync.syncPourAbo);
  const syncLance = useRef(false);
  useEffect(() => {
    if (syncLance.current || me?.aboRole !== "admin") return;
    syncLance.current = true;
    void syncAbo({}).catch(() => {
      /* échec silencieux : les crons n'existent plus, une source externe peut
         être temporairement indisponible sans casser l'espace admin. */
    });
  }, [syncAbo, me]);

  if (me === undefined) {
    return <div className="abo-admin-page abo-admin-state">Chargement…</div>;
  }
  if (!me || me.aboRole !== "admin") {
    return (
      <div className="abo-admin-page abo-admin-state">
        <h2>Accès refusé</h2>
        <p>Vous n'avez pas accès à la gestion des abonnements.</p>
      </div>
    );
  }

  return (
    <div className="abo-admin abo-admin-page">
      <header className="page-header abo-admin-header">
        <Link to="/" className="back-link">
          <ArrowLeft size={16} /> Retour au tableau de bord
        </Link>
        <h1>Abonnements escalade</h1>
        <p className="subtitle">Gestion des nouvelles inscriptions aux créneaux autonomes.</p>
      </header>

      <nav className="abo-admin-nav">
        {TABS.map((t) => {
          const compteur = compteurs[t.id];
          return (
            <button
              key={t.id}
              onClick={() => setVue(t.id)}
              className={`abo-admin-tab${vue === t.id ? " is-active" : ""}`}
            >
              {t.label}
              {compteur !== undefined && compteur > 0 && (
                <span
                  aria-label={`${compteur} élément${compteur > 1 ? "s" : ""} à traiter dans ${t.label}`}
                  className="abo-admin-badge"
                >
                  {compteur}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="abo-admin-view">
        {vue === "dossiers" ? (
          <Dossiers
            onVoirTests={(licence) => {
              setLicenceTest(licence);
              setVue("tests");
            }}
          />
        ) : vue === "messages" ? (
          <Messages />
        ) : vue === "licences" ? (
          <Licences />
        ) : vue === "tests" ? (
          <Tests licenceInitiale={licenceTest} />
        ) : vue === "reglements" ? (
          <Reglements />
        ) : vue === "anomalies" ? (
          <Anomalies />
        ) : vue === "paiements" ? (
          <Paiements />
        ) : vue === "config" ? (
          <Configuration />
        ) : (
          <p className="abo-admin-empty">
            Module « {TABS.find((t) => t.id === vue)?.label} » en cours de
            développement.
          </p>
        )}
      </div>
    </div>
  );
}
