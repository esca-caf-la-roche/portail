import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertTriangle, CalendarSync, CheckCircle2, CircleAlert, Clock3, ListChecks, Plus, RefreshCw, Save, Trash2, UserRoundCog, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSeason } from "../contexts/SeasonContext";
import { planningError } from "./errors";
import "./planning-salaries.css";

type SalarieId = Id<"planning_salaries_annuaire">;
type RessourceGoogle = { libelle: string; resourceCalendarId: string };
const LIMITE_ANNUAIRE = 50;

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
  const ajouterPlusieurs = useMutation(api.planningSalaries.annuaire.ajouterPlusieurs);
  const modifier = useMutation(api.planningSalaries.annuaire.modifier);
  const supprimer = useMutation(api.planningSalaries.annuaire.supprimer);
  const affecter = useMutation(api.planningSalaries.affectations.affecter);
  const retirer = useMutation(api.planningSalaries.affectations.retirer);
  const relancerOperation = useMutation(api.planningSalaries.affectations.relancer);
  const relancerAlerte = useMutation(api.planningSalaries.alertes.relancer);
  const listerRessources = useAction(api.planningSalaries.google.listerRessources);
  const synchroniser = useAction(api.planningSalaries.google.synchroniser);
  const [form, setForm] = useState({ prenom: "", email: "", resourceCalendarId: "" });
  const [edition, setEdition] = useState<SalarieId | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [erreur, setErreur] = useState("");
  const [ressourcesGoogle, setRessourcesGoogle] = useState<RessourceGoogle[] | null>(null);
  const [ressourcesSelectionnees, setRessourcesSelectionnees] = useState<Record<string, boolean>>({});
  const [emailsRessources, setEmailsRessources] = useState<Record<string, string>>({});

  const chargerEdition = (salarie: NonNullable<typeof salaries>[number]) => {
    setEdition(salarie._id);
    setForm({ prenom: salarie.prenom, email: salarie.email, resourceCalendarId: salarie.resourceCalendarId });
  };
  const reinitialiser = () => { setEdition(null); setForm({ prenom: "", email: "", resourceCalendarId: "" }); };

  async function executer(cle: string, action: () => Promise<unknown>, succes: string): Promise<boolean> {
    if (busy) return false;
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
    if (busy) return;
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

  async function chargerRessourcesGoogle() {
    if (busy) return;
    setBusy("ressources"); setErreur(""); setMessage("");
    try {
      const ressources = await listerRessources({});
      setRessourcesGoogle(ressources);
      const idsDisponibles = new Set(ressources.map(({ resourceCalendarId }) => resourceCalendarId));
      setRessourcesSelectionnees((selection) => Object.fromEntries(
        Object.entries(selection).filter(([resourceCalendarId]) => idsDisponibles.has(resourceCalendarId)),
      ));
      setEmailsRessources((emails) => Object.fromEntries(
        Object.entries(emails).filter(([resourceCalendarId]) => idsDisponibles.has(resourceCalendarId)),
      ));
      setMessage(`${ressources.length} ressource${ressources.length > 1 ? "s" : ""} Google récupérée${ressources.length > 1 ? "s" : ""}.`);
    } catch (cause) {
      setErreur(planningError(cause));
    } finally {
      setBusy("");
    }
  }

  async function activerRessources(event: FormEvent) {
    event.preventDefault();
    const idsExistants = new Set(salaries?.map((salarie) => salarie.resourceCalendarId.toLowerCase()) ?? []);
    const ressources = ressourcesGoogle?.filter((ressource) =>
      ressourcesSelectionnees[ressource.resourceCalendarId] &&
      !idsExistants.has(ressource.resourceCalendarId.toLowerCase())) ?? [];
    if (ressources.length === 0) {
      setErreur("Cochez au moins une ressource à activer.");
      return;
    }
    const succes = await executer("activation-ressources", () =>
      ajouterPlusieurs({
        salaries: ressources.map((ressource) => ({
          prenom: ressource.libelle,
          email: emailsRessources[ressource.resourceCalendarId]?.trim() ?? "",
          resourceCalendarId: ressource.resourceCalendarId,
        })),
      }),
      `${ressources.length} salarié${ressources.length > 1 ? "s" : ""} activé${ressources.length > 1 ? "s" : ""}.`,
    );
    if (succes) {
      setRessourcesSelectionnees({});
      setEmailsRessources({});
    }
  }

  if ([planning, etat, salaries, actifs, operations, alertes].some((valeur) => valeur === undefined)) return <div className="pss-state" role="status"><Clock3 aria-hidden="true" />Chargement de la gestion du planning…</div>;
  const parDate = new Map<string, NonNullable<typeof planning>["creneaux"]>();
  for (const creneau of planning!.creneaux) parDate.set(creneau.date, [...(parDate.get(creneau.date) ?? []), creneau]);
  const ressourcesDisponibles = ressourcesGoogle?.filter((ressource) => !salaries!.some((salarie) => salarie.resourceCalendarId.toLowerCase() === ressource.resourceCalendarId.toLowerCase())) ?? [];
  const nombreSelectionne = Object.values(ressourcesSelectionnees).filter(Boolean).length;
  const placesRestantes = Math.max(0, LIMITE_ANNUAIRE - salaries!.length);

  return (
    <div className="pss-manager">
      <section className="pss-manager-hero">
        <div><p className="pss-kicker">Pilotage des relais · saison {season}</p><h1>Planning salariés du samedi</h1><p>Synchronisez Google Agenda, tenez l’annuaire à jour et attribuez chaque point d’ancrage.</p></div>
        <button className="pss-button pss-button--primary" disabled={Boolean(busy)} onClick={() => void synchroniserGoogle()}><CalendarSync aria-hidden="true" />{busy === "sync" ? "Synchronisation…" : "Synchroniser Google"}</button>
      </section>
      {erreur && <div className="pss-alert pss-alert--error" role="alert"><CircleAlert aria-hidden="true" />{erreur}</div>}
      {message && <div className="pss-alert pss-alert--success" role="status"><CheckCircle2 aria-hidden="true" />{message}</div>}
      <section className="pss-status-grid" aria-label="État des automatisations">
        <article><CalendarSync aria-hidden="true" /><div><strong>Google Calendar</strong><span>{etat!.sync?.statut ?? "Jamais synchronisé"}</span><small>{etat!.sync?.derniereSynchronisationAt ? new Date(etat!.sync.derniereSynchronisationAt).toLocaleString("fr-FR") : "Aucune synchronisation aboutie"}</small>{etat!.sync?.derniereErreur && <small className="pss-error-text">{etat!.sync.derniereErreur}</small>}</div></article>
        <article className={etat!.operationsEnErreur > 0 ? "has-error" : ""}><RefreshCw aria-hidden="true" /><div><strong>Mises à jour de ressources</strong><span>{etat!.operationsEnErreur} en erreur</span></div></article>
        <article className={etat!.alertesEnErreur > 0 ? "has-error" : ""}><AlertTriangle aria-hidden="true" /><div><strong>Rappels « À déterminer »</strong><span>{etat!.alertesEnErreur} en erreur</span><small>Lundi à 9 h</small></div></article>
      </section>
      {(operations!.length > 0 || alertes!.length > 0) && <section className="pss-failures" aria-labelledby="pss-failures-title"><h2 id="pss-failures-title"><AlertTriangle aria-hidden="true" />Actions à relancer</h2>
        <ul>{operations!.map((operation) => <li key={operation._id}><span><strong>Mise à jour Google du {operation.date}</strong><small>{operation.derniereErreur ?? "Erreur sans détail"} · {operation.tentatives} tentative(s)</small></span><button className="pss-button pss-button--small" disabled={Boolean(busy)} onClick={() => void executer(operation._id, () => relancerOperation({ operationId: operation._id }), "Mise à jour Google relancée.")}><RefreshCw aria-hidden="true" />Relancer</button></li>)}
        {alertes!.map((alerte) => <li key={alerte._id}><span><strong>Alerte du {dateLongue(alerte.date)}</strong><small>{alerte.derniereErreur ?? "Erreur sans détail"} · {alerte.tentatives} tentative(s)</small></span><button className="pss-button pss-button--small" disabled={Boolean(busy)} onClick={() => void executer(alerte._id, () => relancerAlerte({ alerteId: alerte._id }), "Alerte e-mail relancée.")}><RefreshCw aria-hidden="true" />Relancer</button></li>)}</ul>
      </section>}
      <div className="pss-manager-grid">
        <section className="pss-panel" aria-labelledby="pss-directory-title"><div className="pss-panel-title"><UserRoundCog aria-hidden="true" /><div><p className="pss-kicker">Accès et ressources</p><h2 id="pss-directory-title">Annuaire salarié</h2></div><span>{salaries!.length}</span></div>
          <div className="pss-resource-import">
            <div className="pss-resource-import__heading"><div><h3>Ressources Google disponibles</h3><p>Récupérez les ressources du club, puis cochez les salariés à activer.</p></div><button type="button" className="pss-button pss-button--primary" disabled={Boolean(busy)} onClick={() => void chargerRessourcesGoogle()}><RefreshCw aria-hidden="true" />{busy === "ressources" ? "Récupération…" : ressourcesGoogle ? "Actualiser" : "Récupérer les ressources"}</button></div>
            {ressourcesGoogle !== null && (ressourcesGoogle.length === 0
              ? <p className="pss-resource-empty" role="status">Aucune ressource trouvée dans Google. Vérifiez que les calendriers de ressources sont ajoutés au compte du club.</p>
              : ressourcesDisponibles.length === 0
                ? <p className="pss-resource-empty" role="status">Toutes les ressources Google récupérées sont déjà dans l’annuaire.</p>
                : placesRestantes === 0
                  ? <p className="pss-resource-empty" role="status">Annuaire complet ({salaries!.length}/{LIMITE_ANNUAIRE}). Réactivez ou modifiez une fiche existante ; les fiches inactives comptent dans cette limite.</p>
                  : <form onSubmit={activerRessources}>
                    <fieldset disabled={Boolean(busy)}><legend>Ressources à activer · {nombreSelectionne} sélectionnée{nombreSelectionne !== 1 ? "s" : ""} · {placesRestantes} place{placesRestantes !== 1 ? "s" : ""} disponible{placesRestantes !== 1 ? "s" : ""}</legend><div className="pss-resource-list">{ressourcesDisponibles.map((ressource) => { const selectionnee = Boolean(ressourcesSelectionnees[ressource.resourceCalendarId]); const emailId = `pss-resource-email-${ressource.resourceCalendarId.replace(/[^a-z0-9]/gi, "-")}`; const capaciteAtteinte = !selectionnee && nombreSelectionne >= placesRestantes; return <div className={`pss-resource-row ${selectionnee ? "is-selected" : ""}`} key={ressource.resourceCalendarId}><label className="pss-resource-choice"><input type="checkbox" checked={selectionnee} disabled={capaciteAtteinte} onChange={(event) => setRessourcesSelectionnees((selection) => ({ ...selection, [ressource.resourceCalendarId]: event.target.checked }))} /><span><strong>{ressource.libelle}</strong><small>{ressource.resourceCalendarId}</small></span></label><label htmlFor={emailId}>E-mail de connexion<input id={emailId} type="email" required={selectionnee} disabled={!selectionnee} value={emailsRessources[ressource.resourceCalendarId] ?? ""} onChange={(event) => setEmailsRessources((emails) => ({ ...emails, [ressource.resourceCalendarId]: event.target.value }))} placeholder="prenom@exemple.fr" /></label></div>; })}</div></fieldset>
                    <div className="pss-form-actions"><button className="pss-button pss-button--success" disabled={nombreSelectionne === 0 || Boolean(busy)}><ListChecks aria-hidden="true" />{busy === "activation-ressources" ? "Activation…" : `Activer ${nombreSelectionne} salarié${nombreSelectionne !== 1 ? "s" : ""}`}</button></div>
                  </form>)}
          </div>
          <div className="pss-manual-entry"><h3>{edition ? "Modifier la fiche sélectionnée" : "Ajout manuel"}</h3>
          <form className="pss-directory-form" onSubmit={enregistrer}>
            <label htmlFor="pss-firstname">Prénom<input id="pss-firstname" required value={form.prenom} onChange={(e) => setForm({ ...form, prenom: e.target.value })} /></label>
            <label htmlFor="pss-staff-email">E-mail de connexion et communication<input id="pss-staff-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label htmlFor="pss-resource">Identifiant de ressource Google<input id="pss-resource" required value={form.resourceCalendarId} onChange={(e) => setForm({ ...form, resourceCalendarId: e.target.value })} /></label>
            <div className="pss-form-actions"><button className="pss-button pss-button--success" disabled={Boolean(busy)}>{edition ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}{edition ? "Enregistrer" : "Ajouter"}</button>{edition && <button type="button" className="pss-button pss-button--plain" disabled={Boolean(busy)} onClick={reinitialiser}><X aria-hidden="true" />Annuler</button>}</div>
          </form>
          </div>
          {salaries!.length === 0 ? <div className="pss-state">Aucun salarié activé. Récupérez les ressources Google ci-dessus, cochez les salariés puis renseignez leur e-mail.</div> : <ul className="pss-directory-list">{salaries!.map((salarie) => <li key={salarie._id} className={!salarie.actif ? "is-inactive" : ""}><div><strong>{salarie.prenom}</strong><span>{salarie.email}</span><small>{salarie.resourceCalendarId}</small><em>{salarie.compteLie ? "Compte lié" : "Première connexion en attente"} · {salarie.actif ? "Actif" : "Inactif"}</em></div><div><button className="pss-button pss-button--small" disabled={Boolean(busy)} onClick={() => chargerEdition(salarie)}>Modifier</button>{salarie.actif ? <button className="pss-button pss-button--small pss-button--danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Désactiver ${salarie.prenom} ? Cette personne ne pourra plus se connecter ni recevoir de nouvelle affectation. La fiche pourra être réactivée.`)) void executer(salarie._id, () => supprimer({ salarieId: salarie._id }), "Salarié désactivé."); }}><Trash2 aria-hidden="true" />Désactiver</button> : <button className="pss-button pss-button--small pss-button--success" disabled={Boolean(busy)} onClick={() => void executer(salarie._id, () => modifier({ salarieId: salarie._id, prenom: salarie.prenom, email: salarie.email, resourceCalendarId: salarie.resourceCalendarId, actif: true }), "Salarié réactivé.")}><CheckCircle2 aria-hidden="true" />Réactiver</button>}</div></li>)}</ul>}
        </section>
        <section className="pss-panel pss-panel--counters"><div className="pss-panel-title"><CalendarSync aria-hidden="true" /><div><p className="pss-kicker">Charge de l’équipe</p><h2>Compteurs</h2></div></div><div className="pss-counter-grid">{planning!.compteurs.map((c) => <article key={c.salarieId ?? "placeholder"} className={c.salarieId === null ? "is-open" : ""}><strong>{c.prenom}</strong><span>{c.samedis} samedi{c.samedis > 1 ? "s" : ""}</span></article>)}</div></section>
      </div>
      <section className="pss-manager-calendar" aria-labelledby="pss-calendar-title"><div className="pss-calendar-heading"><div><p className="pss-kicker">Une attribution pour toute la date</p><h2 id="pss-calendar-title">Tous les samedis</h2></div><span>{parDate.size} date{parDate.size > 1 ? "s" : ""}</span></div>
        {parDate.size === 0 ? <div className="pss-state">Synchronisez Google Calendar pour importer les samedis de cette saison.</div> : <ol className="pss-saturday-grid pss-saturday-grid--manager">{Array.from(parDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, creneaux]) => <li className="pss-saturday-card" key={date}>{(() => { const salarie = creneaux[0]?.salarie ?? null; const googleAJour = creneaux.every((creneau) => creneau.googleAJour); return <><header><div><span>Samedi</span><h3>{dateLongue(date)}</h3></div><strong className={salarie ? "is-assigned" : "is-open"}>{salarie?.prenom ?? "À déterminer"}</strong></header><ul className="pss-slot-list">{creneaux.map((creneau) => <li key={creneau._id}><strong>{creneau.groupe}</strong><span>{creneau.debut.slice(11, 16)} – {creneau.fin.slice(11, 16)}</span></li>)}</ul><div className="pss-saturday-manager"><label htmlFor={`pss-assignee-${date}`}>Salarié pour tout le samedi<select id={`pss-assignee-${date}`} value={salarie?._id ?? ""} disabled={Boolean(busy)} onChange={(event) => void executer(date, () => event.target.value ? affecter({ saison: season, date, salarieId: event.target.value as SalarieId }) : retirer({ saison: season, date }), "Affectation du samedi mise à jour ; toutes les ressources Google vont être remplacées.")}><option value="">À déterminer</option>{actifs!.map((s) => <option value={s._id} key={s._id}>{s.prenom}</option>)}</select></label><span className={`pss-google-state ${googleAJour ? "is-ok" : "is-pending"}`}>{googleAJour ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{googleAJour ? "Google à jour" : "Mise à jour Google en cours"}</span></div></>; })()}</li>)}</ol>}
      </section>
    </div>
  );
}
