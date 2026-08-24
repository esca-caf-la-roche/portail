import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { CalendarCheck, CircleAlert, Clock3, LogOut, ShieldX, UserRound } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useSeason } from "../contexts/SeasonContext";
import { formatSamediDate, samediError } from "./errors";

export default function ParticipantCalendar() {
  const { signOut } = useAuthActions();
  const { season, setSeason, availableSeasons } = useSeason();
  const calendrier = useQuery(api.samedis.calendrier.forParticipant, { saison: season });
  const reserver = useMutation(api.samedis.reservations.reserver);
  const annuler = useMutation(api.samedis.reservations.annuler);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "erreur"; texte: string } | null>(null);

  async function agir(id: string, action: () => Promise<unknown>, confirmation?: string) {
    if (confirmation && !window.confirm(confirmation)) return;
    setEnCours(id);
    setMessage(null);
    try {
      await action();
      setMessage({ type: "ok", texte: "Le calendrier a bien été mis à jour." });
    } catch (error) {
      setMessage({ type: "erreur", texte: samediError(error, "Impossible de modifier ce samedi.") });
    } finally {
      setEnCours(null);
    }
  }

  if (calendrier === undefined) return <div className="samedis-state" role="status"><Clock3 aria-hidden="true" /> Chargement du calendrier…</div>;
  const calendrierVerifie = calendrier.configuration?.statutSynchronisation === "ok";

  return (
    <div className="samedis-participant-shell">
      <header className="samedis-public-header">
        <div><p className="samedis-kicker">Club d’escalade · permanences</p><strong>Mes samedis</strong></div>
        <div className="samedis-public-actions">
          <label htmlFor="samedis-season">Saison <select id="samedis-season" value={season} onChange={(event) => setSeason(event.target.value)}>{availableSeasons.map((value) => <option key={value}>{value}</option>)}</select></label>
          <button className="samedis-icon-button" onClick={() => void signOut()} aria-label="Se déconnecter"><LogOut aria-hidden="true" /></button>
        </div>
      </header>
      <main className="samedis-page">
        <section className="samedis-hero">
          <div><p className="samedis-kicker">Saison {season}</p><h1>Qui prend le prochain samedi ?</h1><p>Une seule personne par date. Choisissez un créneau libre, ou annulez l’une de vos permanences.</p></div>
          <div className="samedis-personal-count"><UserRound aria-hidden="true" /><strong>{calendrier.nombreReservations}</strong><span>samedi{calendrier.nombreReservations > 1 ? "s" : ""} réservé{calendrier.nombreReservations > 1 ? "s" : ""}</span></div>
        </section>

        {message && <div className={`samedis-alert samedis-alert--${message.type === "erreur" ? "error" : message.type}`} role={message.type === "erreur" ? "alert" : "status"}>{message.type === "erreur" ? <CircleAlert aria-hidden="true" /> : <CalendarCheck aria-hidden="true" />}{message.texte}</div>}

        {calendrier.configuration && !calendrierVerifie && <div className="samedis-alert" role="status"><Clock3 aria-hidden="true" /><span><strong>Calendrier en attente de vérification</strong><br />Les réservations ouvriront après l’actualisation des jours fériés et vacances scolaires par le club.</span></div>}

        {!calendrier.configuration ? (
          <div className="samedis-state"><CalendarCheck aria-hidden="true" /><strong>Le calendrier n’est pas encore ouvert.</strong><span>Revenez bientôt pour choisir vos samedis.</span></div>
        ) : calendrier.creneaux.length === 0 ? (
          <div className="samedis-state"><CalendarCheck aria-hidden="true" /> Aucun samedi pour cette saison.</div>
        ) : (
          <ol className="samedis-rope-list">
            {calendrier.creneaux.map((creneau) => {
              const libre = calendrierVerifie && !creneau.reservation && !creneau.estBloque;
              const mien = creneau.reservation?.estLaMienne === true;
              const reservationId = creneau.reservation?.estLaMienne
                ? creneau.reservation.reservationId
                : null;
              return (
                <li key={creneau._id} className={`samedis-slot ${mien ? "is-mine" : ""} ${creneau.estBloque ? "is-blocked" : ""}`}>
                  <span className="samedis-carabiner" aria-hidden="true" />
                  <article>
                    <div className="samedis-slot-date"><CalendarCheck aria-hidden="true" /><h2>{formatSamediDate(creneau.date)}</h2></div>
                    {creneau.estBloque && <div className="samedis-status samedis-status--blocked"><ShieldX aria-hidden="true" /><span><strong>Date bloquée</strong>{creneau.motifsBlocage.join(" · ")}</span></div>}
                    {creneau.reservation && <div className={`samedis-status ${mien ? "samedis-status--mine" : ""}`}><UserRound aria-hidden="true" /><span><strong>{mien ? "Votre permanence" : "Déjà réservé"}</strong>{mien ? "Vous êtes inscrit sur cette date." : "Ce samedi n’est plus disponible."}</span></div>}
                    {libre && <button className="samedis-button samedis-button--success" disabled={enCours === creneau._id} onClick={() => void agir(creneau._id, () => reserver({ saison: season, creneauId: creneau._id }))}>{enCours === creneau._id ? "Réservation…" : "Je prends ce samedi"}</button>}
                    {mien && reservationId && <button className="samedis-button samedis-button--danger" disabled={enCours === creneau._id} onClick={() => void agir(creneau._id, () => annuler({ reservationId }), `Annuler votre permanence du ${formatSamediDate(creneau.date)} ?`)}>{enCours === creneau._id ? "Annulation…" : "Annuler ma permanence"}</button>}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}
