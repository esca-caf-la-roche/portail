import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarDays, Check, CircleAlert, Clock3, LogOut, UsersRound } from "lucide-react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import { useSeason } from "../contexts/SeasonContext";
import { planningError } from "./errors";

function dateLongue(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export default function PlanningBoard() {
  const { season, setSeason, availableSeasons } = useSeason();
  const { signOut } = useAuthActions();
  const identity = useQuery(api.planningSalaries.identity.me);
  const planning = useQuery(api.planningSalaries.calendrier.list, { saison: season });
  const affecter = useMutation(api.planningSalaries.affectations.affecter);
  const retirer = useMutation(api.planningSalaries.affectations.retirer);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState("");

  if (identity === undefined || planning === undefined) return <div className="pss-state pss-state--screen" role="status"><Clock3 aria-hidden="true" />Chargement du planning…</div>;
  if (!identity.salarie) return null;
  const moi = identity.salarie;
  const parDate = new Map<string, typeof planning.creneaux>();
  for (const creneau of planning.creneaux) parDate.set(creneau.date, [...(parDate.get(creneau.date) ?? []), creneau]);

  async function agir(date: string, estMoi: boolean) {
    setEnCours(date);
    setErreur("");
    try {
      if (estMoi) await retirer({ saison: season, date });
      else await affecter({ saison: season, date });
    } catch (cause) {
      setErreur(planningError(cause));
    } finally {
      setEnCours(null);
    }
  }

  return (
    <div className="pss-root">
      <header className="pss-public-header">
        <strong>Relais du samedi</strong>
        <div className="pss-header-actions">
          <label htmlFor="pss-season">Saison <select id="pss-season" value={season} onChange={(event) => setSeason(event.target.value)}>{availableSeasons.map((saison) => <option key={saison}>{saison}</option>)}</select></label>
          <span className="pss-connected">Connecté : {moi.prenom}</span>
          <button className="pss-icon-button" aria-label="Se déconnecter" onClick={() => void signOut()}><LogOut aria-hidden="true" /></button>
        </div>
      </header>
      <main className="pss-page">
        <section className="pss-hero">
          <div><p className="pss-kicker">Planning partagé · saison {season}</p><h1>Qui tient la corde&nbsp;?</h1><p>Une inscription couvre tous les groupes et tous les événements du samedi.</p></div>
          <div className="pss-my-count"><strong>{planning.compteurs.find((c) => c.salarieId === moi._id)?.samedis ?? 0}</strong><span>samedis pris</span></div>
        </section>
        {erreur && <div className="pss-alert pss-alert--error" role="alert"><CircleAlert aria-hidden="true" />{erreur}</div>}
        <section aria-labelledby="pss-counters-title" className="pss-counters">
          <h2 id="pss-counters-title"><UsersRound aria-hidden="true" />Compteurs de l’équipe</h2>
          <div className="pss-counter-grid">{planning.compteurs.map((compteur) => <article key={compteur.salarieId ?? "placeholder"} className={compteur.salarieId === null ? "is-open" : ""}><strong>{compteur.prenom}</strong><span>{compteur.samedis} samedi{compteur.samedis > 1 ? "s" : ""}</span></article>)}</div>
        </section>
        {parDate.size === 0 ? <div className="pss-state"><CalendarDays aria-hidden="true" />Aucun samedi n’est encore disponible pour cette saison.</div> : (
          <ol className="pss-saturday-grid">{Array.from(parDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, creneaux]) => (
            <li className="pss-saturday-card" key={date}>{(() => {
              const salarie = creneaux[0]?.salarie ?? null;
              const estMoi = salarie?._id === moi._id;
              const libre = !salarie;
              return <>
              <header><div><span>Samedi</span><h2>{dateLongue(date)}</h2></div><strong className={estMoi ? "is-mine" : libre ? "is-open" : "is-assigned"}>{estMoi ? "Mon samedi" : salarie?.prenom ?? "À déterminer"}</strong></header>
              <ul className="pss-slot-list">{creneaux.map((creneau) => (
                <li key={creneau._id}><strong>{creneau.groupe}</strong><span>{creneau.debut.slice(11, 16)} – {creneau.fin.slice(11, 16)}</span></li>
              ))}</ul>
              <div className="pss-saturday-action"><div className="pss-assignee">{estMoi && <Check aria-hidden="true" />}<span><small>{libre ? "Samedi disponible" : "Pris en charge par"}</small><strong>{salarie?.prenom ?? "À déterminer"}</strong></span></div>{(libre || estMoi) && <button className={`pss-button pss-button--small ${estMoi ? "pss-button--plain" : "pss-button--success"}`} disabled={enCours === date} onClick={() => void agir(date, estMoi)}>{enCours === date ? "Mise à jour…" : estMoi ? "Retirer mon inscription" : "Je prends ce samedi"}</button>}</div>
              </>;
            })()}
            </li>
          ))}</ol>
        )}
      </main>
    </div>
  );
}
