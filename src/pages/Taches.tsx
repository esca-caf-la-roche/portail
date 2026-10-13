import { Component, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckCircle2, Circle, Pencil, Plus, Timer, Trash2, type LucideIcon } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useSeason } from "../contexts/SeasonContext";
import "./Taches.css";

type Tache = FunctionReturnType<typeof api.taches.list>["page"][number];
type Staff = FunctionReturnType<typeof api.taches.annuaireStaff>;
type Statut = "a_faire" | "en_cours" | "terminee";
const STATUTS: Record<Statut, string> = { a_faire: "À faire", en_cours: "En cours", terminee: "Terminée" };
const STATUT_ICONES: Record<Statut, LucideIcon> = { a_faire: Circle, en_cours: Timer, terminee: CheckCircle2 };

function dateLocaleISO(date = new Date()): string {
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  const jour = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mois}-${jour}`;
}

function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/).filter(Boolean);
  if (mots.length === 0) return "?";
  const premiere = mots[0]?.[0] ?? "";
  const seconde = mots.length > 1 ? mots[mots.length - 1]?.[0] ?? "" : "";
  return (premiere + seconde).toUpperCase();
}

function messageErreur(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  return "L’opération a échoué. Réessayez.";
}

class TachesErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: messageErreur(error) }; }
  render() {
    if (this.state.error) return <section className="taches-notice" role="alert">
      <h1>Tâches indisponibles</h1><p>{this.state.error}</p>
      <button type="button" className="btn-secondary" onClick={() => this.setState({ error: null })}>Réessayer</button>
    </section>;
    return this.props.children;
  }
}

export default function Taches() {
  const { season } = useSeason();
  return <TachesErrorBoundary key={season}><TachesSaison saison={season} /></TachesErrorBoundary>;
}

function TachesSaison({ saison }: { saison: string }) {
  const staff = useQuery(api.taches.annuaireStaff, saison ? {} : "skip");
  const current = useQuery(api.users.current);
  const [statut, setStatut] = useState<Statut | "">("");
  const [assigneId, setAssigneId] = useState<Id<"users"> | "">("");
  const { results, status, loadMore } = usePaginatedQuery(api.taches.list,
    saison ? { saison, statut: statut || undefined, assigneId: assigneId || undefined } : "skip",
    { initialNumItems: 25 });
  const setStatus = useMutation(api.taches.setStatus);
  const remove = useMutation(api.taches.remove);
  const [editing, setEditing] = useState<Tache | "new" | null>(null);
  const [deleting, setDeleting] = useState<Tache | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<HTMLElement | null>(null);
  useEffect(() => { if (deleting && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [deleting]);

  function openForm(value: Tache | "new") {
    originRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(value); setError(""); setNotice("");
  }
  function closeForm() {
    setEditing(null);
    requestAnimationFrame(() => (originRef.current?.isConnected ? originRef.current : createRef.current)?.focus());
  }
  async function changeStatus(tache: Tache, next: Statut) {
    setBusy(true); setError(""); setNotice("");
    try { await setStatus({ id: tache._id, saison, statut: next }); setNotice("Statut mis à jour pour tous les assignés."); }
    catch (err) { setError(messageErreur(err)); }
    finally { setBusy(false); }
  }
  async function deleteTask() {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await remove({ id: deleting._id, saison });
      dialogRef.current?.close(); setDeleting(null); setNotice("Tâche supprimée.");
      createRef.current?.focus();
    } catch (err) { setError(messageErreur(err)); }
    finally { setBusy(false); }
  }
  const nom = (id: Id<"users">) => staff?.find((personne) => personne.userId === id)?.nom ?? "Ancien membre du staff";
  const aujourdHui = dateLocaleISO();

  return <div className="taches-page">
    <header className="taches-header">
      <div><h1>Tâches</h1><p className="subtitle">Saison : {saison}</p></div>
      <button ref={createRef} type="button" className="btn-primary" disabled={!staff?.length || !current || !!editing || busy} onClick={() => openForm("new")}><Plus size={18} aria-hidden="true" /> Nouvelle tâche</button>
    </header>
    <p className="taches-intro">Toutes les tâches sont visibles par le staff. Le créateur et les personnes assignées peuvent changer le statut : une tâche terminée l’est pour tout le groupe.</p>
    {notice && <p className="taches-notice" role="status">{notice}</p>}
    {error && !deleting && <p className="taches-notice" role="alert">{error}</p>}
    {editing && staff && <TacheForm key={editing === "new" ? "new" : editing._id} tache={editing === "new" ? undefined : editing} saison={saison} staff={staff} onCancel={closeForm} onSaved={() => { closeForm(); setNotice("Tâche enregistrée."); }} />}
    <section className="taches-filtres" aria-label="Filtrer les tâches">
      <label>Statut<select className="input-field" value={statut} onChange={(e) => setStatut(e.target.value as Statut | "")}><option value="">Tous les statuts</option>{Object.entries(STATUTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Personne assignée<select className="input-field" value={assigneId} disabled={staff === undefined} onChange={(e) => setAssigneId(e.target.value as Id<"users"> | "")}><option value="">Tout le staff</option>{staff?.map((personne) => <option key={personne.userId} value={personne.userId}>{personne.nom}</option>)}</select></label>
      {(statut || assigneId) && <button type="button" className="btn-secondary" onClick={() => { setStatut(""); setAssigneId(""); }}>Effacer les filtres</button>}
    </section>
    {status === "LoadingFirstPage" || staff === undefined || current === undefined ? <p role="status">Chargement des tâches…</p> : <>
      {results.length === 0 && <div className="taches-empty"><h2>{statut || assigneId ? "Aucune tâche pour ces filtres" : "Aucune tâche pour cette saison"}</h2><p>{statut || assigneId ? "Modifiez les filtres ou chargez la suite si elle est disponible." : "Créez une tâche et choisissez les personnes qui s’en occupent."}</p></div>}
      <ul className="taches-list">
        {results.map((tache) => {
          const isCreator = current?._id === tache.createurId;
          const canChange = isCreator || !!current && tache.assigneIds.includes(current._id);
          const Icone = STATUT_ICONES[tache.statut];
          const enRetard = !!tache.echeance && tache.echeance < aujourdHui && tache.statut !== "terminee";
          return <li key={tache._id} className={`taches-item taches-item--${tache.statut}`}>
            <article aria-labelledby={`titre-${tache._id}`}>
              <header className="taches-item-head">
                <h2 id={`titre-${tache._id}`} className="taches-titre">{tache.titre}</h2>
                <div className="taches-item-tools">
                  {canChange
                    ? <select className={`taches-statut taches-statut--${tache.statut} taches-statut--action`} aria-label={`Statut de ${tache.titre}`} value={tache.statut} disabled={busy || !!editing} onChange={(e) => void changeStatus(tache, e.target.value as Statut)}>{Object.entries(STATUTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                    : <span className={`taches-statut taches-statut--${tache.statut}`}><Icone size={14} aria-hidden="true" />{STATUTS[tache.statut]}</span>}
                  {isCreator && <><button type="button" className="btn-icon" disabled={busy || !!editing} title="Modifier" onClick={() => openForm(tache)} aria-label={`Modifier ${tache.titre}`}><Pencil size={18} aria-hidden="true" /></button><button type="button" className="btn-icon danger" disabled={busy || !!editing} title="Supprimer" onClick={() => { setError(""); setDeleting(tache); }} aria-label={`Supprimer ${tache.titre}`}><Trash2 size={18} aria-hidden="true" /></button></>}
                </div>
              </header>
              {tache.description && <p className="taches-description">{tache.description}</p>}
              <dl className="taches-details">
                <div className="taches-detail"><dt>Assigné·es</dt><dd className="taches-assignees">{tache.assigneIds.map((id) => { const libelle = nom(id); return <span key={id} className="taches-assigne"><span className="taches-assigne-initiales" aria-hidden="true">{initiales(libelle)}</span>{libelle}</span>; })}</dd></div>
                <div className="taches-detail"><dt>Échéance</dt><dd>{tache.echeance ? <time className={`taches-echeance${enRetard ? " taches-echeance--retard" : ""}`} dateTime={tache.echeance}>{tache.echeance.split("-").reverse().join("/")}{enRetard ? " · en retard" : ""}</time> : "Sans échéance"}</dd></div>
                <div className="taches-detail"><dt>Créée par</dt><dd>{nom(tache.createurId)}</dd></div>
              </dl>
            </article>
          </li>;
        })}
      </ul>
      <div className="taches-pagination" aria-live="polite">
        <p>{results.length} tâche{results.length > 1 ? "s" : ""} affichée{results.length > 1 ? "s" : ""}</p>
        {status !== "Exhausted" && <button type="button" className="btn-secondary" disabled={status !== "CanLoadMore"} onClick={() => loadMore(25)}>{status === "LoadingMore" ? "Chargement…" : "Afficher les tâches suivantes"}</button>}
      </div>
    </>}
    <dialog ref={dialogRef} className="taches-dialog" aria-labelledby="taches-delete-title" onCancel={(e) => { if (busy) e.preventDefault(); }} onClose={() => setDeleting(null)}>
      <h2 id="taches-delete-title">Supprimer cette tâche ?</h2><p>« {deleting?.titre} » sera supprimée pour tout le staff. Cette action est définitive.</p>
      {error && <p role="alert">{error}</p>}
      <div className="taches-actions"><button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={() => dialogRef.current?.close()}>Annuler</button><button type="button" className="btn-primary" disabled={busy} onClick={() => void deleteTask()}>{busy ? "Suppression…" : "Supprimer définitivement"}</button></div>
    </dialog>
  </div>;
}

function TacheForm({ tache, saison, staff, onCancel, onSaved }: { tache?: Tache; saison: string; staff: Staff; onCancel: () => void; onSaved: () => void }) {
  const create = useMutation(api.taches.create);
  const update = useMutation(api.taches.update);
  const [titre, setTitre] = useState(tache?.titre ?? "");
  const [description, setDescription] = useState(tache?.description ?? "");
  const [echeance, setEcheance] = useState(tache?.echeance ?? "");
  const [assignes, setAssignes] = useState<Id<"users">[]>(tache?.assigneIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!titre.trim() || assignes.length < 1 || assignes.length > 50) { setError("Saisissez un titre et choisissez entre 1 et 50 personnes."); return; }
    setBusy(true); setError("");
    try {
      const args = { saison, titre: titre.trim(), description: description.trim() || undefined, echeance: echeance || undefined, assigneIds: assignes };
      if (tache) await update({ ...args, id: tache._id }); else await create(args);
      onSaved();
    } catch (err) { setError(messageErreur(err)); setBusy(false); }
  }
  const anciens = assignes.filter((id) => !staff.some((personne) => personne.userId === id));
  return <form className="taches-form" onSubmit={(e) => void save(e)} aria-labelledby="tache-form-title">
    <h2 ref={headingRef} tabIndex={-1} id="tache-form-title">{tache ? "Modifier la tâche" : "Nouvelle tâche"}</h2>
    <p>Seul le créateur peut modifier le contenu et les assignations.</p>
    <fieldset disabled={busy}>
      <label>Titre (obligatoire)<input className="input-field" value={titre} required maxLength={160} onChange={(e) => setTitre(e.target.value)} /></label>
      <label>Description<textarea className="input-field" rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>Échéance (facultative)<input className="input-field" type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} /></label>
      <fieldset className="taches-assignes"><legend>Personnes assignées · {assignes.length}/50 (au moins une)</legend>
        {staff.map((personne) => <label key={personne.userId}><input type="checkbox" checked={assignes.includes(personne.userId)} disabled={!assignes.includes(personne.userId) && assignes.length >= 50} onChange={(e) => setAssignes(e.target.checked ? [...assignes, personne.userId] : assignes.filter((id) => id !== personne.userId))} />{personne.nom}</label>)}
        {anciens.map((id) => <label key={id}><input type="checkbox" checked onChange={() => setAssignes(assignes.filter((value) => value !== id))} />Ancien membre du staff — retirer cette assignation</label>)}
      </fieldset>
    </fieldset>
    {error && <p className="taches-notice" role="alert">{error}</p>}
    <div className="taches-actions"><button type="submit" className="btn-primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer la tâche"}</button><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Annuler</button></div>
  </form>;
}
