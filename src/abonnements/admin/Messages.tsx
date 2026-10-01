import { useDeferredValue, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import FilDiscussion from "../FilDiscussion";

type Filtre = "a_traiter" | "cloturee";
type ConversationVue = {
  dossierId: Id<"abo_dossiers">;
  demandeurNom: string;
  demandeurEmail: string;
  statut: Filtre;
  dernierMessageLe: number;
  dernierMessageAuteur: "utilisateur" | "admin";
  dernierMessageExtrait: string;
  messagesNonLusAdmin: number;
};

function formatDate(date: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Boîte de travail partagée : lire ne clôt jamais une conversation. */
export default function Messages() {
  const [filtre, setFiltre] = useState<Filtre>("a_traiter");
  const [recherche, setRecherche] = useState("");
  const rechercheStable = useDeferredValue(recherche);
  const [dossierOuvert, setDossierOuvert] = useState<Id<"abo_dossiers"> | null>(null);
  const { results: conversations, status, loadMore } = usePaginatedQuery(
    api.abo.messages.listerConversationsAdmin,
    { statut: filtre, recherche: rechercheStable },
    { initialNumItems: 25 },
  );

  return (
    <section className="abo-admin-section" aria-labelledby="abo-messages-title">
      <div className="abo-admin-conversation-heading">
        <div>
          <h2 id="abo-messages-title">Messages</h2>
          <p className="abo-admin-intro">Une conversation reste à traiter jusqu’à sa clôture explicite.</p>
        </div>
        <div className="abo-admin-toolbar" aria-label="Filtrer les conversations">
          <button className={`abo-admin-button${filtre === "a_traiter" ? " is-active" : " abo-admin-button--secondary"}`} type="button" onClick={() => { setFiltre("a_traiter"); setDossierOuvert(null); }} aria-pressed={filtre === "a_traiter"}>
            À traiter
          </button>
          <button className={`abo-admin-button${filtre === "cloturee" ? " is-active" : " abo-admin-button--secondary"}`} type="button" onClick={() => { setFiltre("cloturee"); setDossierOuvert(null); }} aria-pressed={filtre === "cloturee"}>
            Clôturées
          </button>
        </div>
      </div>
      <label className="abo-admin-label" htmlFor="abo-messages-recherche">Rechercher une conversation</label>
      <input id="abo-messages-recherche" className="abo-admin-field" type="search" value={recherche} onChange={(event) => setRecherche(event.target.value)} placeholder="Nom ou e-mail" />

      {conversations.length === 0 && status === "LoadingFirstPage" ? <p>Chargement…</p> : conversations.length === 0 ? (
        <p className="abo-admin-empty">{filtre === "a_traiter" ? "Aucune conversation à traiter." : "Aucune conversation clôturée."}</p>
      ) : (
        <div className="abo-admin-list">
          {conversations.map((conversation) => (
            <Conversation
              key={conversation.dossierId}
              conversation={conversation}
              ouverte={dossierOuvert === conversation.dossierId}
              onOuvrir={() => setDossierOuvert((actuel) => actuel === conversation.dossierId ? null : conversation.dossierId)}
            />
          ))}
        </div>
      )}
      {status === "CanLoadMore" && <button className="abo-admin-button abo-admin-button--secondary" type="button" onClick={() => loadMore(25)}>Charger les conversations suivantes</button>}
      {status === "LoadingMore" && <p role="status">Chargement des conversations…</p>}
    </section>
  );
}

function Conversation({
  conversation,
  ouverte,
  onOuvrir,
}: {
  conversation: ConversationVue;
  ouverte: boolean;
  onOuvrir: () => void;
}) {
  const cloturer = useMutation(api.abo.messages.cloturerConversation);
  const reouvrir = useMutation(api.abo.messages.reouvrirConversation);
  const [erreur, setErreur] = useState<string | null>(null);
  const aTraiter = conversation.statut === "a_traiter";

  async function changerStatut() {
    setErreur(null);
    try {
      if (aTraiter) await cloturer({ dossierId: conversation.dossierId });
      else await reouvrir({ dossierId: conversation.dossierId });
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : "La conversation n’a pas pu être mise à jour.");
    }
  }

  return (
    <article className={`abo-admin-card abo-admin-conversation${conversation.messagesNonLusAdmin > 0 ? " abo-admin-card--attention" : ""}`}>
      <div className="abo-admin-card-header">
        <div>
          <strong>{conversation.demandeurNom || "Demandeur non renseigné"}</strong>
          <div className="abo-admin-meta">{conversation.demandeurEmail}</div>
          <p className="abo-admin-conversation-preview"><strong>{conversation.dernierMessageAuteur === "utilisateur" ? "Abonné·e" : "Commission escalade"}</strong> · {formatDate(conversation.dernierMessageLe)}<br />{conversation.dernierMessageExtrait}</p>
        </div>
        <div className="abo-admin-toolbar">
          {conversation.messagesNonLusAdmin > 0 && <strong className="abo-admin-status abo-admin-status--error">{conversation.messagesNonLusAdmin} non lu{conversation.messagesNonLusAdmin > 1 ? "s" : ""}</strong>}
          <strong className={`abo-admin-status ${aTraiter ? "abo-admin-status--warning" : "abo-admin-status--success"}`}>{aTraiter ? "À traiter" : "Clôturée"}</strong>
          <button className="abo-admin-button abo-admin-button--secondary" type="button" onClick={onOuvrir} aria-expanded={ouverte}>{ouverte ? "Fermer le fil" : "Voir et répondre"}</button>
          <button className="abo-admin-button" type="button" onClick={() => void changerStatut()}>{aTraiter ? "Marquer traité" : "Remettre à traiter"}</button>
        </div>
      </div>
      {erreur && <p className="error-message" role="alert">{erreur}</p>}
      {ouverte && <div className="abo-admin-conversation-thread"><FilDiscussion dossierId={conversation.dossierId} hauteur={300} /></div>}
    </article>
  );
}
