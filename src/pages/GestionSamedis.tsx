import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { CalendarCheck, CircleAlert, CloudDownload, MailCheck, Plus, RefreshCcw, Save, ShieldCheck, UsersRound } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { useSeason } from "../contexts/SeasonContext";
import ManagerSlot from "../samedis/ManagerSlot";
import { formatSyncDate, samediError } from "../samedis/errors";
import "../samedis/samedis.css";

type Message = { type: "ok" | "erreur"; texte: string } | null;

function libelleMois(date: string): string {
  const libelle = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(`${date}T12:00:00+02:00`));
  return libelle.charAt(0).toUpperCase() + libelle.slice(1);
}

export default function GestionSamedis() {
  const { season } = useSeason();
  const calendrier = useQuery(api.samedis.calendrier.forManager, { saison: season });
  const participants = useQuery(api.samedis.admin.listParticipants);
  const notificationsEchec = useQuery(api.samedis.notifications.listEchecs);
  const saveConfig = useMutation(api.samedis.admin.upsertConfiguration);
  const addParticipant = useMutation(api.samedis.admin.addParticipant);
  const updateParticipant = useMutation(api.samedis.admin.updateParticipant);
  const synchroniser = useAction(api.samedis.sync.synchroniser);
  const reessayerNotification = useMutation(api.samedis.notifications.reessayer);
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  async function executer(cle: string, action: () => Promise<unknown>, succes: string) {
    setBusy(cle); setMessage(null);
    try { await action(); setMessage({ type: "ok", texte: succes }); }
    catch (error) { setMessage({ type: "erreur", texte: samediError(error, "L’opération n’a pas abouti.") }); }
    finally { setBusy(null); }
  }

  function enregistrerConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (calendrier?.configuration && !window.confirm("Modifier la période peut retirer du planning les samedis non réservés situés hors des nouvelles dates. Continuer ?")) return;
    const donnees = new FormData(event.currentTarget);
    void executer("config", () => saveConfig({ saison: season, dateDebut: String(donnees.get("dateDebut") ?? ""), dateFin: String(donnees.get("dateFin") ?? "") }), "La période et les samedis ont été enregistrés.");
  }

  function ajouterParticipant(event: FormEvent) {
    event.preventDefault();
    void executer("participant", async () => { await addParticipant({ nom, email }); setNom(""); setEmail(""); }, "La personne peut maintenant se connecter avec son e-mail.");
  }

  if (calendrier === undefined || participants === undefined) return <div className="samedis-state" role="status"><CalendarCheck aria-hidden="true" /> Chargement de la gestion des samedis…</div>;
  const config = calendrier.configuration;
  const moisAgenda = new Map<string, { libelle: string; creneaux: typeof calendrier.creneaux }>();
  for (const creneau of calendrier.creneaux) {
    const cle = creneau.date.slice(0, 7);
    const groupe = moisAgenda.get(cle) ?? { libelle: libelleMois(creneau.date), creneaux: [] };
    groupe.creneaux.push(creneau);
    moisAgenda.set(cle, groupe);
  }

  return (
    <div className="samedis-page samedis-manager-page">
      <header className="samedis-hero samedis-manager-hero"><div><p className="samedis-kicker">Saison {season} · espace gestionnaire</p><h1>Les samedis, sans nœuds</h1><p>Configurez la période, attribuez chaque permanence et repérez immédiatement les dates encore libres.</p></div><div className="samedis-mail-note"><MailCheck aria-hidden="true" /><span><strong>Synthèse automatique</strong>Chaque modification est envoyée à l’adresse du club.</span></div></header>
      {message && <div className={`samedis-alert samedis-alert--${message.type === "erreur" ? "error" : message.type}`} role={message.type === "erreur" ? "alert" : "status"}>{message.type === "erreur" ? <CircleAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{message.texte}</div>}

      <section className="samedis-manager-grid">
        <article className="samedis-panel"><div className="samedis-panel-title"><CalendarCheck aria-hidden="true" /><div><p className="samedis-kicker">01 · Saison</p><h2>Période</h2></div></div><form key={`${season}-${config?.dateDebut ?? "nouveau"}-${config?.dateFin ?? ""}`} className="samedis-form samedis-config-form" onSubmit={enregistrerConfiguration}><label>Premier jour<input name="dateDebut" type="date" required defaultValue={config?.dateDebut ?? ""} /></label><label>Dernier jour<input name="dateFin" type="date" required defaultValue={config?.dateFin ?? ""} /></label><button className="samedis-button samedis-button--primary" disabled={busy === "config"}><Save aria-hidden="true" />{busy === "config" ? "Enregistrement…" : config ? "Enregistrer la période" : "Générer les samedis"}</button></form>{config && config.statutSynchronisation !== "ok" && <div className="samedis-alert"><CircleAlert aria-hidden="true" /><span><strong>Vérification officielle requise</strong><br />Actualisez les jours fériés et vacances avant d’attribuer les samedis.</span></div>}{config && <div className="samedis-sync"><span><CloudDownload aria-hidden="true" /><strong>Calendrier officiel</strong><small>{formatSyncDate(config.derniereSynchronisation)}{config.erreurSynchronisation ? ` · ${config.erreurSynchronisation}` : ""}</small></span><button className="samedis-button samedis-button--small samedis-button--warning" disabled={busy === "sync"} onClick={() => void executer("sync", async () => { const resultat = await synchroniser({ saison: season, actualiserMemeSiRecent: true }); if (!resultat.lancee) throw new Error("Une synchronisation est déjà en cours. Réessayez dans quelques secondes."); }, "Jours fériés et vacances de Grenoble actualisés.")}><CloudDownload aria-hidden="true" />{busy === "sync" ? "Synchronisation…" : "Vérifier le calendrier"}</button></div>}</article>

        <article className="samedis-panel"><div className="samedis-panel-title"><UsersRound aria-hidden="true" /><div><p className="samedis-kicker">02 · Accès</p><h2>Participants</h2></div><span className="samedis-count-badge">{participants.filter((p) => p.actif).length} actifs</span></div><form className="samedis-inline-form samedis-add-person" onSubmit={ajouterParticipant}><label>Nom<input required value={nom} onChange={(e) => setNom(e.target.value)} /></label><label>E-mail<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><button className="samedis-button samedis-button--success samedis-button--small" disabled={busy === "participant"}><Plus aria-hidden="true" />Ajouter</button></form>{participants.length === 0 ? <div className="samedis-empty-people"><UsersRound aria-hidden="true" />Aucun participant. Ajoutez la première personne pour pouvoir attribuer un samedi.</div> : <ul className="samedis-people-list">{participants.map((participant) => { const compteur = calendrier.compteurs.find((item) => item.participantId === participant._id)?.nombreReservations ?? 0; return <li key={participant._id}><span><strong>{participant.nom}</strong><small>{participant.email} · {participant.connecte ? "compte activé" : "jamais connecté"}</small></span><span className="samedis-person-count">{compteur} samedi{compteur > 1 ? "s" : ""}</span><button className={`samedis-toggle ${participant.actif ? "is-active" : ""}`} disabled={busy === participant._id} onClick={() => void executer(participant._id, () => updateParticipant({ participantId: participant._id as Id<"samedis_participants">, nom: participant.nom, email: participant.email, actif: !participant.actif }), participant.actif ? "Participant désactivé." : "Participant réactivé.")} aria-pressed={participant.actif}>{participant.actif ? "Actif" : "Inactif"}</button></li>; })}</ul>}</article>
      </section>

      {notificationsEchec === undefined ? (
        <div className="samedis-notifications-state" role="status">Vérification des synthèses e-mail…</div>
      ) : notificationsEchec.length > 0 ? (
        <section className="samedis-notifications" aria-labelledby="samedis-notifications-title">
          <div><CircleAlert aria-hidden="true" /><span><strong id="samedis-notifications-title">{notificationsEchec.length} synthèse{notificationsEchec.length > 1 ? "s" : ""} non envoyée{notificationsEchec.length > 1 ? "s" : ""}</strong><small>Les modifications sont enregistrées. Vous pouvez relancer chaque envoi.</small></span></div>
          <ul>{notificationsEchec.map((notification) => <li key={notification._id}><span><strong>{notification.resume}</strong><small>{notification.saison ? `Saison ${notification.saison} · ` : ""}{notification.tentatives} tentative{notification.tentatives > 1 ? "s" : ""}{notification.derniereErreur ? ` · ${notification.derniereErreur}` : ""}</small></span><button className="samedis-button samedis-button--small samedis-button--warning" disabled={busy === notification._id} onClick={() => void executer(notification._id, () => reessayerNotification({ notificationId: notification._id }), "L’envoi de la synthèse a été relancé.")}><RefreshCcw aria-hidden="true" />{busy === notification._id ? "Relance…" : "Réessayer"}</button></li>)}</ul>
        </section>
      ) : null}

      <section className="samedis-calendar-section">
        <div className="samedis-calendar-heading"><div><p className="samedis-kicker">03 · Agenda</p><h2>Qui prend quel samedi ?</h2></div><div className="samedis-calendar-summary"><span><strong>{calendrier.creneaux.filter((c) => !c.reservation && !c.estBloque).length}</strong> libres</span><span><strong>{calendrier.creneaux.filter((c) => c.reservation).length}</strong> attribués</span><span><strong>{calendrier.creneaux.filter((c) => c.estBloque).length}</strong> indisponibles</span></div></div>
        {!config ? <div className="samedis-state"><CalendarCheck aria-hidden="true" /> Enregistrez d’abord la période de la saison.</div> : calendrier.creneaux.length === 0 ? <div className="samedis-state"><CalendarCheck aria-hidden="true" /> Aucun samedi dans cette période.</div> : <div className="samedis-agenda">{Array.from(moisAgenda, ([cle, mois]) => <section key={cle} className="samedis-agenda-month"><header><span>{cle.slice(5)}</span><h3>{mois.libelle}</h3><small>{mois.creneaux.length} samedi{mois.creneaux.length > 1 ? "s" : ""}</small></header><ol className="samedis-agenda-grid">{mois.creneaux.map((creneau) => <ManagerSlot key={`${creneau._id}-${creneau.blocageManuel}-${creneau.motifBlocageManuel ?? ""}-${creneau.reservation?.aRegulariser ?? false}`} creneau={creneau} participants={participants} saison={season} calendrierVerifie={config.statutSynchronisation === "ok"} />)}</ol></section>)}</div>}
      </section>
    </div>
  );
}
