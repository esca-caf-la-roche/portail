import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertTriangle, CalendarSync, CheckCircle2, CircleAlert, Clock3, Plus, RefreshCw, Save, Trash2, UserRoundCog, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSeason } from "../contexts/SeasonContext";
import { planningError } from "./errors";
import "./planning-salaries.css";

type SalarieId = Id<"planning_salaries_annuaire">;

function dateLongue(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export default function GestionPlanningSalaries() {
  const { season } = useSeason();
  const planning = useQuery(api.planningSalaries.calendrier.list, { saison: season });
  const etat = useQuery(api.planningSalaries.calendrier.etatGestionnaire, { saison: season });
  const salaries = useQuery(api.planningSalaries.annuaire.list);
  const actifs = useQuery(api.planningSalaries.annuaire.listActifs);
  const operations = useQuery(api.planningSalaries.affectations.listEchecs, { saison: season });
  const alertes = useQuery(api.planningSalaries.alertes.listEchecs, { saison: season });
  const ajouter = useMutation(api.planningSalaries.annuaire.ajouter);
  const modifier = useMutation(api.planningSalaries.annuaire.modifier);
  const supprimer = useMutation(api.planningSalaries.annuaire.supprimer);
  const affecter = useMutation(api.planningSalaries.affectations.affecter);
  const retirer = useMutation(api.planningSalaries.affectations.retirer);
  const relancerOperation = useMutation(api.planningSalaries.affectations.relancer);
  const relancerAlerte = useMutation(api.planningSalaries.alertes.relancer);
  const synchroniser = useAction(api.planningSalaries.google.synchroniser);
  const [form, setForm] = useState({ prenom: "", email: "", resourceCalendarId: "" });
  const [edition, setEdition] = useState<SalarieId | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [erreur, setErreur] = useState("");

  const chargerEdition = (salarie: NonNullable<typeof salaries>[number]) => {
    setEdition(salarie._id);
    setForm({ prenom: salarie.prenom, email: salarie.email, resourceCalendarId: salarie.resourceCalendarId });
  };
  const reinitialiser = () => { setEdition(null); setForm({ prenom: "", email: "", resourceCalendarId: "" }); };

  async function executer(cle: string, action: () => Promise<unknown>, succes: string): Promise<boolean> {
    setBusy(cle); setErreur(""); setMessage("");
    try { await action(); setMessage(succes); return true; }
    catch (cause) { setErreur(planningError(cause)); return false; }
    finally { setBusy(""); }
  }

  async function enregistrer(event: FormEvent) {
    event.preventDefault();
    const donnees = { prenom: form.prenom, email: form.email, resourceCalendarId: form.resourceCalendarId };
    const succes = await executer("annuaire", () => edition
      ? modifier({ salarieId: edition, ...donnees, actif: salaries?.find((s) => s._id === edition)?.actif ?? true })
      : ajouter(donnees), edition ? "Fiche salarié mise à jour." : "Salarié ajouté à l’annuaire.");
    if (succes) reinitialiser();
  }

  async function synchroniserGoogle() {
    setBusy("sync"); setErreur(""); setMessage("");
    try {
      const resultat = await synchroniser({ saison: season });
      setMessage(resultat.lancee
        ? "Planning Google synchronisé."
        : "Le planning a déjà été synchronisé il y a moins d’une heure.");
    } catch (cause) {
      setErreur(planningError(cause));
    } finally {
      setBusy("");
    }
  }

  if ([planning, etat, salaries, actifs, operations, alertes].some((valeur) => valeur === undefined)) return <div className="pss-state" role="status"><Clock3 aria-hidden="true" />Chargement de la gestion du planning…</div>;
  const parDate = new Map<string, NonNullable<typeof planning>["creneaux"]>();
  for (const creneau of planning!.creneaux) parDate.set(creneau.date, [...(parDate.get(creneau.date) ?? []), creneau]);

  return (
    <div className="pss-manager">
      <section className="pss-manager-hero">
        <div><p className="pss-kicker">Pilotage des relais · saison {season}</p><h1>Planning salariés du samedi</h1><p>Synchronisez Google Agenda, tenez l’annuaire à jour et attribuez chaque point d’ancrage.</p></div>
        <button className="pss-button pss-button--primary" disabled={busy === "sync"} onClick={() => void synchroniserGoogle()}><CalendarSync aria-hidden="true" />{busy === "sync" ? "Synchronisation…" : "Synchroniser Google"}</button>
      </section>
      {erreur && <div className="pss-alert pss-alert--error" role="alert"><CircleAlert aria-hidden="true" />{erreur}</div>}
      {message && <div className="pss-alert pss-alert--success" role="status"><CheckCircle2 aria-hidden="true" />{message}</div>}
      <section className="pss-status-grid" aria-label="État des automatisations">
        <article><CalendarSync aria-hidden="true" /><div><strong>Google Calendar</strong><span>{etat!.sync?.statut ?? "Jamais synchronisé"}</span><small>{etat!.sync?.derniereSynchronisationAt ? new Date(etat!.sync.derniereSynchronisationAt).toLocaleString("fr-FR") : "Aucune synchronisation aboutie"}</small>{etat!.sync?.derniereErreur && <small className="pss-error-text">{etat!.sync.derniereErreur}</small>}</div></article>
        <article className={etat!.operationsEnErreur > 0 ? "has-error" : ""}><RefreshCw aria-hidden="true" /><div><strong>Mises à jour de ressources</strong><span>{etat!.operationsEnErreur} en erreur</span></div></article>
        <article className={etat!.alertesEnErreur > 0 ? "has-error" : ""}><AlertTriangle aria-hidden="true" /><div><strong>Alertes à J−7</strong><span>{etat!.alertesEnErreur} en erreur</span></div></article>
      </section>
      {(operations!.length > 0 || alertes!.length > 0) && <section className="pss-failures" aria-labelledby="pss-failures-title"><h2 id="pss-failures-title"><AlertTriangle aria-hidden="true" />Actions à relancer</h2>
        <ul>{operations!.map((operation) => <li key={operation._id}><span><strong>Mise à jour Google du {operation.date}</strong><small>{operation.derniereErreur ?? "Erreur sans détail"} · {operation.tentatives} tentative(s)</small></span><button className="pss-button pss-button--small" disabled={busy === operation._id} onClick={() => void executer(operation._id, () => relancerOperation({ operationId: operation._id }), "Mise à jour Google relancée.")}><RefreshCw aria-hidden="true" />Relancer</button></li>)}
        {alertes!.map((alerte) => <li key={alerte._id}><span><strong>Alerte du {dateLongue(alerte.date)}</strong><small>{alerte.derniereErreur ?? "Erreur sans détail"} · {alerte.tentatives} tentative(s)</small></span><button className="pss-button pss-button--small" disabled={busy === alerte._id} onClick={() => void executer(alerte._id, () => relancerAlerte({ alerteId: alerte._id }), "Alerte e-mail relancée.")}><RefreshCw aria-hidden="true" />Relancer</button></li>)}</ul>
      </section>}
      <div className="pss-manager-grid">
        <section className="pss-panel" aria-labelledby="pss-directory-title"><div className="pss-panel-title"><UserRoundCog aria-hidden="true" /><div><p className="pss-kicker">Accès et ressources</p><h2 id="pss-directory-title">Annuaire salarié</h2></div><span>{salaries!.length}</span></div>
          <form className="pss-directory-form" onSubmit={enregistrer}>
            <label htmlFor="pss-firstname">Prénom<input id="pss-firstname" required value={form.prenom} onChange={(e) => setForm({ ...form, prenom: e.target.value })} /></label>
            <label htmlFor="pss-staff-email">E-mail de connexion et communication<input id="pss-staff-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label htmlFor="pss-resource">Identifiant de ressource Google<input id="pss-resource" required value={form.resourceCalendarId} onChange={(e) => setForm({ ...form, resourceCalendarId: e.target.value })} /></label>
            <div className="pss-form-actions"><button className="pss-button pss-button--success" disabled={busy === "annuaire"}>{edition ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}{edition ? "Enregistrer" : "Ajouter"}</button>{edition && <button type="button" className="pss-button pss-button--plain" onClick={reinitialiser}><X aria-hidden="true" />Annuler</button>}</div>
          </form>
          {salaries!.length === 0 ? <div className="pss-state">Ajoutez le premier salarié pour ouvrir les inscriptions.</div> : <ul className="pss-directory-list">{salaries!.map((salarie) => <li key={salarie._id} className={!salarie.actif ? "is-inactive" : ""}><div><strong>{salarie.prenom}</strong><span>{salarie.email}</span><small>{salarie.resourceCalendarId}</small><em>{salarie.compteLie ? "Compte lié" : "Première connexion en attente"} · {salarie.actif ? "Actif" : "Inactif"}</em></div><div><button className="pss-button pss-button--small" onClick={() => chargerEdition(salarie)}>Modifier</button>{salarie.actif ? <button className="pss-button pss-button--small pss-button--danger" disabled={busy === salarie._id} onClick={() => void executer(salarie._id, () => supprimer({ salarieId: salarie._id }), "Salarié désactivé.")}><Trash2 aria-hidden="true" />Désactiver</button> : <button className="pss-button pss-button--small pss-button--success" disabled={busy === salarie._id} onClick={() => void executer(salarie._id, () => modifier({ salarieId: salarie._id, prenom: salarie.prenom, email: salarie.email, resourceCalendarId: salarie.resourceCalendarId, actif: true }), "Salarié réactivé.")}><CheckCircle2 aria-hidden="true" />Réactiver</button>}</div></li>)}</ul>}
        </section>
        <section className="pss-panel pss-panel--counters"><div className="pss-panel-title"><CalendarSync aria-hidden="true" /><div><p className="pss-kicker">Charge de l’équipe</p><h2>Compteurs</h2></div></div><div className="pss-counter-grid">{planning!.compteurs.map((c) => <article key={c.salarieId ?? "placeholder"} className={c.salarieId === null ? "is-open" : ""}><strong>{c.prenom}</strong><span>{c.samedis} samedi{c.samedis > 1 ? "s" : ""}</span></article>)}</div></section>
      </div>
      <section className="pss-manager-calendar" aria-labelledby="pss-calendar-title"><div className="pss-calendar-heading"><div><p className="pss-kicker">Une attribution pour toute la date</p><h2 id="pss-calendar-title">Tous les samedis</h2></div><span>{parDate.size} date{parDate.size > 1 ? "s" : ""}</span></div>
        {parDate.size === 0 ? <div className="pss-state">Synchronisez Google Calendar pour importer les samedis de cette saison.</div> : <ol className="pss-rope-list pss-rope-list--manager">{Array.from(parDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, creneaux]) => <li className="pss-crossing" key={date}>{(() => { const salarie = creneaux[0]?.salarie ?? null; const googleAJour = creneaux.every((creneau) => creneau.googleAJour); return <><header><span className="pss-knot" aria-hidden="true" /><div><span>Samedi</span><h3>{dateLongue(date)}</h3></div><strong>{salarie?.prenom ?? "À déterminer"}</strong></header><div className="pss-saturday-manager"><label htmlFor={`pss-assignee-${date}`}>Salarié pour tout le samedi<select id={`pss-assignee-${date}`} value={salarie?._id ?? ""} disabled={busy === date} onChange={(event) => void executer(date, () => event.target.value ? affecter({ saison: season, date, salarieId: event.target.value as SalarieId }) : retirer({ saison: season, date }), "Affectation du samedi mise à jour ; toutes les ressources Google vont être remplacées.")}><option value="">À déterminer</option>{actifs!.map((s) => <option value={s._id} key={s._id}>{s.prenom}</option>)}</select></label><span className={`pss-google-state ${googleAJour ? "is-ok" : "is-pending"}`}>{googleAJour ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{googleAJour ? "Tous les événements Google sont à jour" : "Mises à jour Google en cours"}</span></div><ul>{creneaux.map((creneau) => <li key={creneau._id} className={!salarie ? "is-open" : "is-taken"}><div><span className="pss-anchor" aria-hidden="true" /><div><h3>{creneau.groupe}</h3><p>{creneau.debut.slice(11, 16)} – {creneau.fin.slice(11, 16)}</p></div></div></li>)}</ul></>; })()}</li>)}</ol>}
      </section>
    </div>
  );
}
