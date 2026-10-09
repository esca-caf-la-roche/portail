import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { Download, Eye, EyeOff, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { Infer } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  CATEGORIES,
  CIVILITES,
  GROUPES,
  MAX_IMPORT,
  normaliserTexte,
  planValidator,
  type AmbassadeurFields,
} from "../../convex/competitionModel";
import { useSeason } from "../contexts/SeasonContext";
import { chargerToutesLesFiches, erreurCompetition, exporterCompetitionCsv, lireFichierCompetition } from "../utils/competitionExcel";
import "./Competition.css";

const EMPTY: AmbassadeurFields = { nom: "", prenom: "", dateNaissance: "", civilite: "", categories: "", groupe: "", email: "" };

// Source unique de vérité du tableau et du formulaire : chaque champ du modèle
// est décrit une fois, typé par `keyof AmbassadeurFields`. Aucune colonne
// surnuméraire ou désynchronisée ne peut apparaître (Colonne 1 a été retirée).
type Champ = {
  cle: keyof AmbassadeurFields;
  label: string;
  type: "text" | "date" | "email" | "select";
  options?: readonly string[];
  required?: boolean;
  maxLength?: number;
};
const CHAMPS: Champ[] = [
  { cle: "nom", label: "Nom", type: "text", required: true },
  { cle: "prenom", label: "Prénom", type: "text", required: true },
  { cle: "dateNaissance", label: "Date de naissance", type: "date", required: true },
  { cle: "civilite", label: "Civilité", type: "select", options: CIVILITES },
  { cle: "categories", label: "Catégorie", type: "select", options: CATEGORIES },
  { cle: "groupe", label: "Quel groupe", type: "select", options: GROUPES },
  { cle: "email", label: "Email", type: "email", maxLength: 254 },
];

type Plan = Infer<typeof planValidator>;

function formatDate(iso: string): string {
  return iso ? iso.split("-").reverse().join("/") : "—";
}

function StatutSignature({ signe }: { signe: boolean }) {
  return <span className={`competition-badge competition-badge--${signe ? "signe" : "attente"}`}>{signe ? "Signé" : "Non signé"}</span>;
}

export default function Competition() {
  const { season } = useSeason();
  // Le remount efface aussi les requêtes, fichiers et formulaires de l'ancienne saison.
  return <CompetitionSeason key={season} saison={season} />;
}

function CompetitionSeason({ saison }: { saison: string }) {
  const convex = useConvex();
  const create = useMutation(api.competition.create);
  const update = useMutation(api.competition.update);
  const setSigne = useMutation(api.competition.setPartenariatSigne);
  const remove = useMutation(api.competition.remove);
  const importRows = useMutation(api.competition.importRows);
  const synchroniserArkose = useAction(api.competitionArkoseWebhook.synchroniser);
  const lierSignatureArkose = useMutation(api.competition.lierSignatureArkose);
  const delierSignatureArkose = useMutation(api.competition.delierSignatureArkose);
  const masquerSignatureArkose = useMutation(api.competition.masquerSignatureArkose);
  const afficherSignatureArkose = useMutation(api.competition.afficherSignatureArkose);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const page = useQuery(api.competition.list, saison ? { saison, paginationOpts: { cursor, numItems: 50, maximumRowsRead: 100 } } : "skip");
  const [showHiddenSignatures, setShowHiddenSignatures] = useState(false);
  const signaturesArkose = useQuery(api.competition.listSignaturesArkose, saison ? { saison, inclureMasquees: showHiddenSignatures } : "skip");
  const ambassadeursArkose = useQuery(api.competition.listAmbassadeursArkose, saison ? { saison } : "skip");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [signed, setSigned] = useState("");
  const [editing, setEditing] = useState<Doc<"competition_ambassadeurs"> | "new" | null>(null);
  const [fields, setFields] = useState<AmbassadeurFields>(EMPTY);
  const [signature, setSignature] = useState(false);
  const [deleting, setDeleting] = useState<Doc<"competition_ambassadeurs"> | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectionArkose, setSelectionArkose] = useState<Record<string, Id<"competition_ambassadeurs">[]>>({});
  const formRef = useRef<HTMLHeadingElement>(null);
  const deleteModalRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  // La confirmation de suppression est une modale : elle reste visible quelle
  // que soit la position du tableau, prend le focus, garde le focus à l'intérieur
  // et se ferme par Échap.
  useEffect(() => { if (deleting) deleteCancelRef.current?.focus(); }, [deleting]);
  useEffect(() => {
    if (!deleting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setDeleting(null); return; }
      if (event.key !== "Tab" || !deleteModalRef.current) return;
      const focusables = deleteModalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleting, busy]);
  const rows = page?.page ?? [];
  const needle = normaliserTexte(search);
  const visible = rows.filter((r) => (!category || r.categories === category) && (!group || r.groupe === group) && (!signed || r.partenariatSigne === (signed === "oui")) && normaliserTexte(`${r.nom} ${r.prenom} ${r.email} ${r.categories}`).includes(needle));
  const signes = visible.filter((r) => r.partenariatSigne).length;
  const filtresActifs = Boolean(search || category || group || signed);

  function openForm(doc: Doc<"competition_ambassadeurs"> | "new") {
    setEditing(doc);
    setDeleting(null);
    setPlans(null);
    setError("");
    setFields(doc === "new" ? EMPTY : { nom: doc.nom, prenom: doc.prenom, dateNaissance: doc.dateNaissance, civilite: doc.civilite, categories: doc.categories, groupe: doc.groupe, email: doc.email });
    setSignature(doc === "new" ? false : doc.partenariatSigne);
    requestAnimationFrame(() => formRef.current?.focus());
  }

  async function operation(fn: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); } catch (err) { setError(erreurCompetition(err)); }
    finally { setBusy(false); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void operation(async () => {
      if (!editing) return;
      if (editing === "new") await create({ saison, fields, partenariatSigne: signature });
      else await update({ saison, id: editing._id, revision: editing.revision, fields, partenariatSigne: signature });
      setEditing(null); setMessage("Fiche enregistrée.");
    });
  }

  function resetFiltres() {
    setSearch(""); setCategory(""); setGroup(""); setSigned("");
  }

  return <div className="competition-page">
    <header className="competition-header">
      <div>
        <h1>Compétition · Arkose</h1>
        <p className="subtitle">Saison : {saison} · Ambassadeurs et partenariats</p>
      </div>
      <div className="competition-stats" aria-label="Résumé">
        <span className="competition-stat"><strong>{visible.length}</strong> fiche(s)</span>
        <span className="competition-stat competition-stat--signe"><strong>{signes}</strong> signé(s)</span>
        <span className="competition-stat competition-stat--attente"><strong>{visible.length - signes}</strong> non signé(s)</span>
      </div>
    </header>
    <p className="competition-hint">Les signatures peuvent être suivies manuellement ou importées depuis Arkose. Civilité, catégorie et groupe sont des valeurs choisies dans des listes.</p>
    {error && !deleting && <p className="competition-notice competition-notice--error" role="alert">{error}</p>}
    {message && <p className="competition-notice competition-notice--info" role="status">{message}</p>}

    <div className="competition-toolbar competition-toolbar--principal">
      <button type="button" className="btn-primary" disabled={busy} onClick={() => openForm("new")}>Ajouter un ambassadeur</button>
      <label className="competition-file competition-file--button">Importer XLSX ou CSV <span>(200 lignes, 2 Mo)</span>
        <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          setPlans(null); setConfirmation(false); setEditing(null); setDeleting(null);
          void operation(async () => {
            const imported = await lireFichierCompetition(file, saison);
            const result = await convex.query(api.competition.previewImport, { saison, rows: imported });
            setPlans(result);
          });
        }} />
      </label>
      <button type="button" className="btn-secondary competition-action-button" disabled={busy} onClick={() => void operation(async () => {
        const rows = await chargerToutesLesFiches((cursor) => convex.query(api.competition.list, { saison, paginationOpts: { cursor, numItems: 50, maximumRowsRead: 100 } }));
        exporterCompetitionCsv(rows, saison);
        const limiteImport = rows.length > MAX_IMPORT ? ` Au-delà de ${MAX_IMPORT} fiches, découpez le fichier pour le réimport.` : "";
        setMessage(`${rows.length} fiche(s) exportée(s) en CSV, saison entière ${saison}.${limiteImport}`);
      })}><Download size={18} aria-hidden="true" /><span><strong>Exporter la saison</strong><small>CSV Excel · jusqu’à 2 000 fiches</small></span></button>
      <button type="button" className="btn-secondary competition-action-button" disabled={busy} onClick={() => void operation(async () => {
        const result = await synchroniserArkose({ saison });
        setMessage(`Arkose : ${result.recus} signature(s) reçue(s), ${result.autoLinked} rapprochée(s) automatiquement, ${result.queued} à relier, ${result.ignored} déjà connue(s).`);
      })}><RefreshCw size={18} aria-hidden="true" className={busy ? "competition-spin" : undefined} /><span><strong>Importer les signatures Arkose</strong><small>Synchronisation à la demande · aucune donnée envoyée</small></span></button>
    </div>

    <section className="competition-panel" aria-labelledby="competition-arkose-title">
      <h2 id="competition-arkose-title">Signatures Arkose à rapprocher</h2>
      <p>Une signature sans correspondance unique reste ici. Sélectionnez un ou plusieurs ambassadeurs : un adulte peut signer pour plusieurs enfants. Une signature de test peut être masquée sans être supprimée.</p>
      <label className="competition-check competition-hidden-toggle"><input type="checkbox" checked={showHiddenSignatures} onChange={(event) => setShowHiddenSignatures(event.target.checked)} /> Afficher les signatures masquées</label>
      {signaturesArkose === undefined || ambassadeursArkose === undefined ? <p role="status">Chargement des signatures…</p> : signaturesArkose.length === 0 ? <p className="competition-empty">Aucune signature Arkose importée.</p> : <div className="competition-scroll"><table><caption>Signatures Arkose de la saison</caption><thead><tr><th>Signataire reçu</th><th>Ambassadeurs à relier</th><th>Action</th></tr></thead><tbody>{signaturesArkose.map((signatureArkose) => {
        const selection = selectionArkose[signatureArkose._id] ?? [];
        return <tr key={signatureArkose._id}><td>{signatureArkose.prenom} {signatureArkose.nom}<br />{signatureArkose.statut === "masquee" ? <span className="competition-action competition-action--masquee">Masquée</span> : <StatutSignature signe={signatureArkose.statut === "lie"} />}</td><td>{signatureArkose.statut !== "masquee" && <>{signatureArkose.liens.length > 0 && <p>{signatureArkose.liens.map((lien) => <span key={lien.ambassadeurId} className="competition-arkose-link">{lien.prenom} {lien.nom} <button type="button" className="btn-text" disabled={busy} onClick={() => void operation(async () => { await delierSignatureArkose({ saison, signatureId: signatureArkose._id, ambassadeurId: lien.ambassadeurId }); setMessage("Liaison Arkose retirée : vous pouvez corriger ou supprimer la fiche."); })}>Retirer</button></span>)}</p>}<fieldset disabled={busy} className="competition-arkose-options"><legend className="sr-only">Ambassadeurs pour {signatureArkose.prenom} {signatureArkose.nom}</legend>{ambassadeursArkose.map((ambassadeur) => <label key={ambassadeur._id} className="competition-check"><input type="checkbox" checked={selection.includes(ambassadeur._id)} onChange={(event) => setSelectionArkose((current) => ({ ...current, [signatureArkose._id]: event.target.checked ? [...selection, ambassadeur._id] : selection.filter((id) => id !== ambassadeur._id) }))} />{ambassadeur.prenom} {ambassadeur.nom} · {formatDate(ambassadeur.dateNaissance)}</label>)}</fieldset></>}</td><td>{signatureArkose.statut === "masquee" ? <button type="button" className="btn-secondary competition-inline-action" disabled={busy} onClick={() => void operation(async () => { await afficherSignatureArkose({ saison, signatureId: signatureArkose._id }); setMessage("Signature Arkose réaffichée."); })}><Eye size={16} aria-hidden="true" /> Réafficher</button> : <><button type="button" className="btn-primary" disabled={busy || selection.length === 0} onClick={() => void operation(async () => {
          const result = await lierSignatureArkose({ saison, signatureId: signatureArkose._id, ambassadeurIds: selection });
          setSelectionArkose((current) => ({ ...current, [signatureArkose._id]: [] }));
          setMessage(`${result.lies} liaison(s) Arkose enregistrée(s).`);
        })}>Relier la signature</button>{signatureArkose.statut === "a_rapprocher" && <button type="button" className="btn-text competition-inline-action" disabled={busy} onClick={() => void operation(async () => { await masquerSignatureArkose({ saison, signatureId: signatureArkose._id }); setMessage("Signature Arkose masquée. Elle sera ignorée lors des prochains imports."); })}><EyeOff size={16} aria-hidden="true" /> Masquer</button>}</>}</td></tr>;
      })}</tbody></table></div>}
    </section>

    {editing && <section className="competition-panel" aria-labelledby="competition-form-title">
      <h2 id="competition-form-title" ref={formRef} tabIndex={-1}>{editing === "new" ? "Nouvel ambassadeur" : "Modifier l’ambassadeur"}</h2>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="competition-fields">
          <legend>Identité et coordonnées</legend>
          {CHAMPS.map((champ) => <label key={champ.cle}>{champ.label}{champ.required ? " *" : ""}
            {champ.type === "select" ? <select value={fields[champ.cle]} onChange={(e) => setFields({ ...fields, [champ.cle]: e.target.value })}>
              <option value="">—</option>
              {champ.options?.map((option) => <option key={option} value={option}>{option}</option>)}
            </select> : <input
              type={champ.type}
              required={champ.required}
              maxLength={champ.maxLength ?? (champ.cle === "dateNaissance" ? 10 : 200)}
              min={champ.type === "date" ? "1900-01-01" : undefined}
              max={champ.type === "date" ? "2100-12-31" : undefined}
              value={fields[champ.cle]}
              onChange={(e) => setFields({ ...fields, [champ.cle]: e.target.value })}
            />}
          </label>)}
          <label className="competition-check"><input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} /> Partenariat signé (confirmation manuelle)</label>
        </fieldset>
        <div className="competition-toolbar"><button className="btn-primary" disabled={busy}>Enregistrer · {saison}</button><button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Annuler</button></div>
      </form>
    </section>}

    {plans && <section className="competition-panel" aria-labelledby="competition-import-title">
      <h2 id="competition-import-title">Prévisualisation · saison {saison}</h2>
      <p>{plans.filter((p) => p.action === "creation").length} création(s), {plans.filter((p) => p.action === "modification").length} modification(s), {plans.filter((p) => p.action === "identique").length} inchangée(s). Aucune suppression.</p>
      <p>Sans colonne « Partenariat signé », les signatures existantes sont conservées. Si elle est présente, ses valeurs Oui/Non les remplacent. L’ancienne colonne « Colonne 1 », si elle est présente dans un ancien fichier, est ignorée.</p>
      <div className="competition-scroll"><table><caption>Fiches à importer · différences avant → après</caption><thead><tr>{CHAMPS.map((champ) => <th key={champ.cle}>{champ.label}</th>)}<th>Partenariat signé</th><th>Action</th></tr></thead><tbody>{plans.map((p, i) => <tr key={i}>
        {CHAMPS.map((champ) => <td key={champ.cle}>{p.before && p.before[champ.cle] !== p.row[champ.cle] ? <span className="competition-diff"><span>Avant : {p.before[champ.cle] || "(vide)"}</span><strong>Après : {p.row[champ.cle] || "(vide)"}</strong></span> : p.row[champ.cle] || "(vide)"}</td>)}
        <td>{p.before && p.row.partenariatSigne !== undefined && p.before.partenariatSigne !== p.row.partenariatSigne ? `Avant : ${p.before.partenariatSigne ? "Oui" : "Non"} → Après : ${p.row.partenariatSigne ? "Oui" : "Non"}` : <StatutSignature signe={(p.row.partenariatSigne ?? p.before?.partenariatSigne ?? false)} />}</td><td><span className={`competition-action competition-action--${p.action}`}>{p.action}</span></td>
      </tr>)}</tbody></table></div>
      <label className="competition-check"><input type="checkbox" disabled={busy} checked={confirmation} onChange={(e) => setConfirmation(e.target.checked)} /> Je confirme la saison {saison} et ces modifications, y compris les signatures présentes dans le fichier.</label>
      <div className="competition-toolbar"><button className="btn-primary" disabled={busy || !confirmation} onClick={() => void operation(async () => {
        const result = await importRows({ saison, plans }); setPlans(null); setConfirmation(false); setCursor(null); setPageNumber(1);
        setMessage(`Import terminé : ${result.created} créée(s), ${result.updated} modifiée(s), ${result.unchanged} inchangée(s).`);
      })}>Confirmer l’import · {saison}</button><button className="btn-secondary" disabled={busy} onClick={() => setPlans(null)}>Annuler</button></div>
    </section>}

    {deleting && <div className="competition-modal-backdrop" onMouseDown={() => { if (!busy) setDeleting(null); }}>
      <div ref={deleteModalRef} className="competition-modal" role="dialog" aria-modal="true" aria-labelledby="competition-delete-title" aria-describedby="competition-delete-desc" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="competition-delete-title">Supprimer cette fiche ?</h2>
        <p id="competition-delete-desc"><strong>{deleting.nom} {deleting.prenom}</strong> · {saison}. Cette suppression est définitive.</p>
        {error && <p className="competition-notice competition-notice--error" role="alert">{error}</p>}
        <div className="competition-toolbar">
          <button type="button" className="competition-btn-danger" disabled={busy} onClick={() => void operation(async () => {
            await remove({ saison, id: deleting._id, revision: deleting.revision }); setDeleting(null); setMessage("Fiche supprimée.");
          })}>Confirmer la suppression</button>
          <button type="button" ref={deleteCancelRef} className="btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>Annuler</button>
        </div>
      </div>
    </div>}

    <section className="competition-panel" aria-label="Liste des ambassadeurs">
      <div className="competition-list-head">
        <h2>Liste des ambassadeurs</h2>
        {filtresActifs && <button type="button" className="btn-text competition-reset" disabled={busy} onClick={resetFiltres}>Réinitialiser les filtres</button>}
      </div>
      <div className="competition-filters">
        <label>Rechercher (nom, email, catégorie)<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>Catégorie<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Toutes</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Groupe<select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Tous les groupes</option>{GROUPES.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
        <label>Partenariat signé<select value={signed} onChange={(e) => setSigned(e.target.value)}><option value="">Tous</option><option value="oui">Signé</option><option value="non">Non signé</option></select></label>
      </div>
      <p className="competition-scope">Recherche et filtres portent sur la page affichée (50 fiches maximum). L’export inclut toute la saison, sans ces filtres, et se réimporte par fichiers de {MAX_IMPORT} fiches maximum. {visible.length} résultat(s).</p>
      {page === undefined ? <p role="status">Chargement…</p> : visible.length === 0 ? <p className="competition-empty">Aucun ambassadeur sur cette page pour ces critères.</p> : <div className="competition-scroll"><table>
        <caption>Ambassadeurs · {saison}</caption>
        <thead><tr>{CHAMPS.map((champ) => <th key={champ.cle}>{champ.label}</th>)}<th>Partenariat signé</th><th>Actions</th></tr></thead>
        <tbody>{visible.map((r) => <tr key={r._id}>{CHAMPS.map((champ) => <td key={champ.cle}>{champ.cle === "dateNaissance" ? formatDate(r.dateNaissance) : (r[champ.cle] || "—")}</td>)}<td><button type="button" className="competition-badge-btn" disabled={busy} aria-pressed={r.partenariatSigne} title={r.partenariatSigne ? "Marquer le partenariat comme non signé" : "Marquer le partenariat comme signé"} aria-label={`${r.partenariatSigne ? "Marquer non signé" : "Marquer signé"} : ${r.prenom} ${r.nom}`} onClick={() => void operation(async () => {
          await setSigne({ saison, id: r._id, revision: r.revision, partenariatSigne: !r.partenariatSigne });
          setMessage(r.partenariatSigne ? `Partenariat de ${r.prenom} ${r.nom} marqué non signé.` : `Partenariat de ${r.prenom} ${r.nom} marqué signé.`);
        })}><StatutSignature signe={r.partenariatSigne} /></button></td><td><div className="competition-row-actions"><button type="button" className="btn-icon competition-icon-btn" disabled={busy} title="Modifier" aria-label={`Modifier ${r.prenom} ${r.nom}`} onClick={() => openForm(r)}><Pencil size={18} aria-hidden="true" /></button><button type="button" className="btn-icon competition-icon-btn btn-icon--danger" disabled={busy} title="Supprimer" aria-label={`Supprimer ${r.prenom} ${r.nom}`} onClick={() => { setDeleting(r); setEditing(null); setPlans(null); setError(""); setMessage(""); }}><Trash2 size={18} aria-hidden="true" /></button></div></td></tr>)}</tbody>
      </table></div>}
      <div className="competition-toolbar competition-pagination">
        <button className="btn-secondary" disabled={busy || cursor === null} onClick={() => { setCursor(null); setPageNumber(1); setGroup(""); }}>Première page</button>
        <span className="competition-page-number">Page {pageNumber}</span>
        <button className="btn-secondary" disabled={busy || !page || page.isDone} onClick={() => { if (page) { setPageNumber(pageNumber + 1); setCursor(page.continueCursor); setGroup(""); } }}>Page suivante</button>
      </div>
    </section>
  </div>;
}
