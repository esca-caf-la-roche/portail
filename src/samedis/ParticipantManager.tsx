import { useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { Check, Copy, ExternalLink, Pencil, Plus, Save, Trash2, UserRound, UsersRound, X } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { samediError } from "./errors";

type Participant = {
  _id: Id<"samedis_participants">;
  nom: string;
  email: string;
  actif: boolean;
  connecte: boolean;
};

type Compteur = {
  participantId: Id<"samedis_participants">;
  nombreReservations: number;
};

type Message = { type: "ok" | "erreur"; texte: string };

function ParticipantRow({
  participant,
  nombreReservations,
  onMessage,
  onParticipantRemoved,
}: {
  participant: Participant;
  nombreReservations: number;
  onMessage: (message: Message) => void;
  onParticipantRemoved: () => void;
}) {
  const updateParticipant = useMutation(api.samedis.admin.updateParticipant);
  const removeParticipant = useMutation(api.samedis.admin.removeParticipant);
  const [edition, setEdition] = useState(false);
  const [nom, setNom] = useState(participant.nom);
  const [email, setEmail] = useState(participant.email);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState("");
  const modifierRef = useRef<HTMLButtonElement>(null);

  function fermerEdition() {
    setEdition(false);
    window.requestAnimationFrame(() => modifierRef.current?.focus());
  }

  async function executer(action: () => Promise<unknown>, succes: string) {
    setBusy(true);
    setErreur("");
    try {
      await action();
      onMessage({ type: "ok", texte: succes });
      return true;
    } catch (error) {
      setErreur(samediError(error, "La modification du participant n’a pas abouti."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function annulerEdition() {
    setNom(participant.nom);
    setEmail(participant.email);
    setErreur("");
    fermerEdition();
  }

  async function enregistrer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reussi = await executer(
      () => updateParticipant({ participantId: participant._id, nom, email, actif: participant.actif }),
      "Participant modifié.",
    );
    if (reussi) fermerEdition();
  }

  function supprimer() {
    if (nombreReservations > 0) {
      setErreur(`Annulez d’abord ${nombreReservations > 1 ? "les réservations" : "la réservation"} de ${participant.nom} avant de supprimer son accès.`);
      return;
    }
    if (!window.confirm(`Supprimer ${participant.nom} des participants ? Son accès Samedis sera retiré ; son compte utilisateur sera conservé.`)) return;
    void (async () => {
      const reussi = await executer(() => removeParticipant({ participantId: participant._id }), "Participant supprimé.");
      if (reussi) onParticipantRemoved();
    })();
  }

  if (edition) {
    return (
      <li className="samedis-person-item is-editing">
        <form className="samedis-person-edit-form" onSubmit={(event) => void enregistrer(event)}>
          <label htmlFor={`participant-nom-${participant._id}`}>Nom
            <input id={`participant-nom-${participant._id}`} required autoFocus value={nom} onChange={(event) => setNom(event.target.value)} />
          </label>
          <label htmlFor={`participant-email-${participant._id}`}>E-mail
            <input id={`participant-email-${participant._id}`} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <div className="samedis-person-edit-actions">
            <button type="submit" className="samedis-button samedis-button--success samedis-button--small" disabled={busy}><Save aria-hidden="true" />Enregistrer</button>
            <button type="button" className="samedis-button samedis-button--small" disabled={busy} onClick={annulerEdition}><X aria-hidden="true" />Annuler</button>
          </div>
          {erreur && <p className="samedis-inline-error samedis-person-error" role="alert">{erreur}</p>}
        </form>
      </li>
    );
  }

  return (
    <li className="samedis-person-item">
      <span className="samedis-person-identity"><strong>{participant.nom}</strong><small>{participant.email} · {participant.connecte ? "compte activé" : "jamais connecté"}</small></span>
      <span className="samedis-person-count">{nombreReservations} samedi{nombreReservations > 1 ? "s" : ""}</span>
      <div className="samedis-person-actions">
        <button
          type="button"
          className={`samedis-toggle ${participant.actif ? "is-active" : ""}`}
          disabled={busy}
          onClick={() => void executer(
            () => updateParticipant({ participantId: participant._id, nom: participant.nom, email: participant.email, actif: !participant.actif }),
            participant.actif ? "Participant désactivé." : "Participant réactivé.",
          )}
          aria-pressed={participant.actif}
        ><Check aria-hidden="true" />{participant.actif ? "Actif" : "Inactif"}</button>
        <button ref={modifierRef} type="button" className="samedis-button samedis-button--small samedis-person-edit" disabled={busy} onClick={() => { setNom(participant.nom); setEmail(participant.email); setErreur(""); setEdition(true); }}><Pencil aria-hidden="true" />Modifier</button>
        <button type="button" className="samedis-button samedis-button--danger samedis-button--small" disabled={busy} onClick={supprimer}><Trash2 aria-hidden="true" />Supprimer</button>
      </div>
      {erreur && <p className="samedis-inline-error samedis-person-error" role="alert">{erreur}</p>}
    </li>
  );
}

export default function ParticipantManager({ participants, compteurs, onMessage }: {
  participants: Participant[];
  compteurs: Compteur[];
  onMessage: (message: Message) => void;
}) {
  const addParticipant = useMutation(api.samedis.admin.addParticipant);
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [copie, setCopie] = useState(false);
  const lienRef = useRef<HTMLInputElement>(null);
  const titreRef = useRef<HTMLHeadingElement>(null);
  const lienParticipant = useMemo(() => {
    const url = new URL(window.location.href);
    url.hash = "/samedis";
    return url.toString();
  }, []);

  async function ajouterParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await addParticipant({ nom, email });
      setNom("");
      setEmail("");
      onMessage({ type: "ok", texte: "La personne peut maintenant se connecter avec son e-mail." });
    } catch (error) {
      onMessage({ type: "erreur", texte: samediError(error, "L’ajout du participant n’a pas abouti.") });
    } finally {
      setBusy(false);
    }
  }

  async function copierLien() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard indisponible");
      await navigator.clipboard.writeText(lienParticipant);
      setCopie(true);
      window.setTimeout(() => setCopie(false), 2500);
    } catch {
      if (navigator.share) {
        try {
          await navigator.share({ title: "Réservation de la salle le samedi", url: lienParticipant });
          onMessage({ type: "ok", texte: "Le lien de connexion a été partagé." });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      lienRef.current?.focus();
      lienRef.current?.select();
      onMessage({ type: "ok", texte: "Le lien est sélectionné. Utilisez l’action Copier de votre appareil." });
    }
  }

  return (
    <article className="samedis-panel">
      <div className="samedis-panel-title"><UsersRound aria-hidden="true" /><div><p className="samedis-kicker">02 · Accès</p><h2 ref={titreRef} tabIndex={-1}>Participants</h2></div><span className="samedis-count-badge">{participants.filter((participant) => participant.actif).length} actifs</span></div>

      <aside className="samedis-share-link" aria-labelledby="samedis-share-title">
        <div><ExternalLink aria-hidden="true" /><span><strong id="samedis-share-title">Lien à partager</strong><small>Les participants utilisent ce lien pour recevoir leur code de connexion.</small></span></div>
        <div className="samedis-share-controls">
          <label className="samedis-visually-hidden" htmlFor="samedis-participant-link">Lien de connexion des participants</label>
          <input ref={lienRef} id="samedis-participant-link" readOnly value={lienParticipant} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="samedis-button samedis-button--primary samedis-button--small" onClick={() => void copierLien()}><Copy aria-hidden="true" />{copie ? "Copié !" : "Copier"}</button>
          <a className="samedis-button samedis-button--small samedis-share-open" href={lienParticipant} target="_blank" rel="noreferrer" aria-label="Ouvrir le lien participant dans un nouvel onglet"><ExternalLink aria-hidden="true" />Ouvrir</a>
        </div>
        <span className="samedis-visually-hidden" role="status" aria-live="polite">{copie ? "Lien copié dans le presse-papiers." : ""}</span>
      </aside>

      <form className="samedis-inline-form samedis-add-person" onSubmit={(event) => void ajouterParticipant(event)}>
        <label htmlFor="samedis-new-participant-name">Nom<input id="samedis-new-participant-name" required value={nom} onChange={(event) => setNom(event.target.value)} /></label>
        <label htmlFor="samedis-new-participant-email">E-mail<input id="samedis-new-participant-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="submit" className="samedis-button samedis-button--success samedis-button--small" disabled={busy}><Plus aria-hidden="true" />{busy ? "Ajout…" : "Ajouter"}</button>
      </form>

      {participants.length === 0 ? (
        <div className="samedis-empty-people"><UserRound aria-hidden="true" />Aucun participant. Ajoutez la première personne pour pouvoir attribuer un samedi.</div>
      ) : (
        <ul className="samedis-people-list">
          {participants.map((participant) => (
            <ParticipantRow
              key={participant._id}
              participant={participant}
              nombreReservations={compteurs.find((item) => item.participantId === participant._id)?.nombreReservations ?? 0}
              onMessage={onMessage}
              onParticipantRemoved={() => window.requestAnimationFrame(() => titreRef.current?.focus())}
            />
          ))}
        </ul>
      )}
    </article>
  );
}
