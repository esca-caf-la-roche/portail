import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { Ban, CalendarCheck, GraduationCap, Hand, Landmark, Settings2, ShieldAlert, Trash2, UserPlus, UserRound } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { formatSamediDate, samediError } from "./errors";

type Creneau = {
  _id: Id<"samedis_creneaux">;
  date: string;
  estBloque: boolean;
  motifsBlocage: string[];
  sourcesBlocage: Array<"ferie" | "vacances" | "manuel">;
  blocageManuel: boolean;
  blocageOfficiel: boolean;
  ouvertureManuelle: boolean;
  motifBlocageManuel: string | null;
  reservation: null | {
    _id: Id<"samedis_reservations">;
    participantNom: string;
    forcee: boolean;
    aRegulariser: boolean;
  };
};

type Participant = { _id: Id<"samedis_participants">; nom: string; actif: boolean };

export default function ManagerSlot({ creneau, participants, saison, calendrierVerifie }: { creneau: Creneau; participants: Participant[]; saison: string; calendrierVerifie: boolean }) {
  const updateCreneau = useMutation(api.samedis.admin.updateCreneau);
  const reserver = useMutation(api.samedis.reservations.reserverCommeGestionnaire);
  const annuler = useMutation(api.samedis.reservations.annulerCommeGestionnaire);
  const regulariser = useMutation(api.samedis.reservations.regulariserReservation);
  const [blocage, setBlocage] = useState(creneau.blocageManuel);
  const [ouvertureManuelle, setOuvertureManuelle] = useState(creneau.ouvertureManuelle);
  const [motifBlocage, setMotifBlocage] = useState(creneau.motifBlocageManuel ?? "");
  const [participantId, setParticipantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState("");
  const participantsActifs = participants.filter((participant) => participant.actif);
  const estVacances = creneau.sourcesBlocage.includes("vacances");
  const controleOuvertureOfficielle = creneau.blocageOfficiel && !creneau.blocageManuel;
  const motifsOfficiels = creneau.motifsBlocage.filter(
    (_motif, index) => creneau.sourcesBlocage[index] !== "manuel",
  );
  const attributionClass = creneau.reservation
    ? "is-attributed"
    : calendrierVerifie && participantsActifs.length > 0
      ? "is-available"
      : "is-attribution-closed";

  async function executer(action: () => Promise<unknown>, fallback: string) {
    setBusy(true); setErreur("");
    try { await action(); }
    catch (error) { setErreur(samediError(error, fallback)); }
    finally { setBusy(false); }
  }

  function modifier(event: FormEvent) {
    event.preventDefault();
    void executer(
      () => updateCreneau(controleOuvertureOfficielle
        ? {
            creneauId: creneau._id,
            bloqueManuellement: false,
            ouvertureManuelle,
          }
        : {
            creneauId: creneau._id,
            bloqueManuellement: blocage,
            ouvertureManuelle: false,
            motif: blocage ? motifBlocage : undefined,
          }),
      "Impossible de modifier la disponibilité de ce samedi.",
    );
  }

  function attribuer(event: FormEvent) {
    event.preventDefault();
    if (!participantId) return;
    void executer(() => reserver({ saison, creneauId: creneau._id, participantId: participantId as Id<"samedis_participants">, forcer: creneau.estBloque }), "Impossible d’attribuer ce samedi.");
  }

  function regulariserReservation(event: FormEvent) {
    event.preventDefault();
    if (!creneau.reservation) return;
    void executer(
      () => regulariser({ reservationId: creneau.reservation!._id }),
      "Impossible de régulariser cette permanence.",
    );
  }

  return (
    <li className={`samedis-slot samedis-slot--manager ${attributionClass} ${creneau.estBloque ? "is-blocked" : ""} ${estVacances ? "est-en-vacances-scolaires" : ""} ${creneau.reservation ? "is-reserved" : ""}`}>
      <span className="samedis-carabiner" aria-hidden="true" />
      <article>
        <header className="samedis-slot-manager-head"><div className="samedis-slot-date"><CalendarCheck aria-hidden="true" /><h3>{formatSamediDate(creneau.date)}</h3></div></header>
        {creneau.sourcesBlocage.length > 0 && <div className="samedis-blockage-list" aria-label="Contexte du calendrier et motifs du club">{creneau.motifsBlocage.map((motif, index) => { const source = creneau.sourcesBlocage[index] ?? "manuel"; const Icon = source === "ferie" ? Landmark : source === "vacances" ? GraduationCap : Hand; const libelle = source === "ferie" ? "Jour férié" : source === "vacances" ? "Vacances scolaires" : "Blocage du club"; return <span key={`${source}-${motif}`} className={`samedis-blockage-badge samedis-blockage-badge--${source}`}><Icon aria-hidden="true" /><span><strong>{libelle}</strong>{motif.replace(/^(Jour férié|Vacances scolaires)\s*:\s*/i, "")}</span></span>; })}</div>}
        {creneau.ouvertureManuelle && !creneau.estBloque && <div className="samedis-status samedis-status--exception"><CalendarCheck aria-hidden="true" /><span><strong>Exception du club — disponible malgré le calendrier officiel</strong>{motifsOfficiels.join(" · ")}</span></div>}
        {creneau.reservation ? (
          <div className="samedis-reservation-stack"><div className="samedis-manager-reservation"><div className="samedis-status samedis-status--mine"><UserRound aria-hidden="true" /><span><strong>{creneau.reservation.participantNom}</strong>{creneau.reservation.forcee ? "Inscription maintenue sur une date bloquée" : "Permanence confirmée"}</span></div><button className="samedis-button samedis-button--danger samedis-button--small" disabled={busy} onClick={() => { if (window.confirm("Annuler cette permanence ?")) void executer(() => annuler({ reservationId: creneau.reservation!._id }), "Impossible d’annuler la permanence."); }}><Trash2 aria-hidden="true" /> Annuler</button></div>{creneau.reservation.aRegulariser && <div className="samedis-regularisation"><p><ShieldAlert aria-hidden="true" /><span><strong>Régularisation requise</strong>Cette permanence existait avant le blocage de la date. Maintenez-la explicitement, ou annulez-la.</span></p><form onSubmit={regulariserReservation}><button className="samedis-button samedis-button--small samedis-button--warning" disabled={busy}>Maintenir la permanence</button></form></div>}</div>
        ) : (
          calendrierVerifie && participantsActifs.length > 0 ? <form className="samedis-inline-form" onSubmit={attribuer}>
            <label>Attribuer à<select required value={participantId} onChange={(event) => setParticipantId(event.target.value)}><option value="">Choisir une personne</option>{participantsActifs.map((p) => <option key={p._id} value={p._id}>{p.nom}</option>)}</select></label>
            <button className={`samedis-button samedis-button--small ${creneau.estBloque ? "samedis-button--warning" : "samedis-button--success"}`} disabled={busy}><UserPlus aria-hidden="true" />{creneau.estBloque ? "Forcer l’inscription" : "Attribuer"}</button>
          </form> : <div className="samedis-status"><ShieldAlert aria-hidden="true" /><span><strong>Attribution fermée</strong>{calendrierVerifie ? "Ajoutez ou réactivez d’abord un participant." : "Actualisez d’abord le calendrier officiel de la saison."}</span></div>
        )}
        <details className="samedis-slot-settings"><summary><Settings2 aria-hidden="true" /> Disponibilité du samedi</summary><form onSubmit={modifier} className={`samedis-inline-form ${controleOuvertureOfficielle ? "samedis-availability-form--official" : ""}`}>{controleOuvertureOfficielle ? <label className="samedis-checkbox"><input type="checkbox" checked={ouvertureManuelle} onChange={(event) => setOuvertureManuelle(event.target.checked)} /><CalendarCheck aria-hidden="true" /> Rendre ce samedi disponible malgré le calendrier officiel</label> : <><label className="samedis-checkbox"><input type="checkbox" checked={blocage} onChange={(event) => setBlocage(event.target.checked)} /><Ban aria-hidden="true" /> Rendre ce samedi indisponible</label>{creneau.blocageOfficiel && creneau.blocageManuel && <p className="samedis-availability-note">Retirez d’abord le blocage du club. Le samedi restera indisponible tant que l’exception au calendrier officiel n’est pas activée.</p>}{blocage && <label>Motif du blocage<input required value={motifBlocage} onChange={(event) => setMotifBlocage(event.target.value)} /></label>}</>}<button className="samedis-button samedis-button--small" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer la disponibilité"}</button></form></details>
        {erreur && <p className="samedis-inline-error" role="alert"><ShieldAlert aria-hidden="true" />{erreur}</p>}
      </article>
    </li>
  );
}
