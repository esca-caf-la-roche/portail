import { useRef, useState, type FormEvent } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { Infer } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { normaliserTexte, planValidator, type AmbassadeurFields } from "../../convex/competitionModel";
import { useSeason } from "../contexts/SeasonContext";
import { chargerExportSaison, erreurCompetition, exporterCompetition, lireFichierCompetition } from "../utils/competitionExcel";
import "./Competition.css";

const EMPTY: AmbassadeurFields = { nom: "", prenom: "", dateNaissance: "", civilite: "", categories: "", colonne1: "", groupe: "", email: "" };
const LABELS: Record<keyof AmbassadeurFields, string> = { nom: "Nom", prenom: "Prénom", dateNaissance: "Date de naissance", civilite: "Civilité", categories: "Catégories", colonne1: "Colonne 1", groupe: "Quels groupe", email: "Email" };
type Plan = Infer<typeof planValidator>;

export default function Competition() {
  const { season } = useSeason();
  // Le remount efface aussi les requêtes, fichiers et formulaires de l'ancienne saison.
  return <CompetitionSeason key={season} saison={season} />;
}

function CompetitionSeason({ saison }: { saison: string }) {
  const convex = useConvex();
  const create = useMutation(api.competition.create);
  const update = useMutation(api.competition.update);
  const remove = useMutation(api.competition.remove);
  const importRows = useMutation(api.competition.importRows);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const page = useQuery(api.competition.list, saison ? { saison, paginationOpts: { cursor, numItems: 50, maximumRowsRead: 100 } } : "skip");
  const [search, setSearch] = useState("");
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
  const [exportBatches, setExportBatches] = useState<Doc<"competition_ambassadeurs">[][] | null>(null);
  const formRef = useRef<HTMLHeadingElement>(null);
  const rows = page?.page ?? [];
  const groups = [...new Set(rows.map((r) => r.groupe))].sort();
  const needle = normaliserTexte(search);
  const visible = rows.filter((r) => (!group || r.groupe === group) && (!signed || r.partenariatSigne === (signed === "oui")) && normaliserTexte(`${r.nom} ${r.prenom} ${r.email} ${r.categories}`).includes(needle));

  function openForm(doc: Doc<"competition_ambassadeurs"> | "new") {
    setEditing(doc);
    setDeleting(null);
    setPlans(null);
    setError("");
    setFields(doc === "new" ? EMPTY : { nom: doc.nom, prenom: doc.prenom, dateNaissance: doc.dateNaissance, civilite: doc.civilite, categories: doc.categories, colonne1: doc.colonne1, groupe: doc.groupe, email: doc.email });
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

  return <div className="competition-page">
    <header className="page-header"><h1>Compétition · Arkose</h1><p className="subtitle">Saison : {saison} · Ambassadeurs et partenariats</p></header>
    <p>La case « Partenariat signé » est un suivi manuel, sans envoi ni signature électronique.</p>
    {error && <p className="competition-notice" role="alert">{error}</p>}
    {message && <p className="competition-notice" role="status">{message}</p>}
    <div className="competition-toolbar">
      <button type="button" className="btn-primary" disabled={busy} onClick={() => openForm("new")}>Ajouter un ambassadeur</button>
      <label className="competition-file">Importer XLSX (200 lignes, 2 Mo)
        <input type="file" accept=".xlsx" disabled={busy} onChange={(event) => {
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
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => void operation(async () => {
        setExportBatches(null);
        const batches = await chargerExportSaison((cursor) => convex.query(api.competition.list, { saison, paginationOpts: { cursor, numItems: 50, maximumRowsRead: 100 } }));
        setExportBatches(batches);
        setMessage(`${batches.reduce((n, b) => n + b.length, 0)} fiche(s) préparée(s), saison entière ${saison}.`);
      })}>Préparer l’export de toute la saison (maximum 2000)</button>
    </div>
    {exportBatches && <section className="competition-panel" aria-label="Export complet de la saison">
      <p>Export de toute la saison, sans les filtres de la liste. Téléchargez chaque lot (200 fiches maximum) pour conserver l’ensemble. Évitez les modifications pendant la préparation paginée ; les révisions protègent la réimportation si les données changent ensuite.</p>
      <div className="competition-toolbar">{exportBatches.map((batch, i) => <button key={i} className="btn-secondary" disabled={busy} onClick={() => void operation(async () => {
        await exporterCompetition(batch, saison, `-lot-${i + 1}-sur-${exportBatches.length}`);
      })}>Télécharger lot {i + 1}/{exportBatches.length} ({batch.length} fiches)</button>)}</div>
    </section>}

    {editing && <section className="competition-panel" aria-labelledby="competition-form-title">
      <h2 id="competition-form-title" ref={formRef} tabIndex={-1}>{editing === "new" ? "Nouvel ambassadeur" : "Modifier l’ambassadeur"}</h2>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="competition-fields">
          <legend>Identité et coordonnées</legend>
          {(Object.keys(LABELS) as (keyof AmbassadeurFields)[]).map((key) => <label key={key}>{LABELS[key]}{["nom", "prenom", "dateNaissance"].includes(key) ? " *" : ""}
            <input type={key === "dateNaissance" ? "date" : key === "email" ? "email" : "text"} required={["nom", "prenom", "dateNaissance"].includes(key)} maxLength={key === "email" ? 254 : 200} min={key === "dateNaissance" ? "1900-01-01" : undefined} max={key === "dateNaissance" ? "2100-12-31" : undefined} value={fields[key]} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} />
          </label>)}
          <label className="competition-check"><input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} /> Partenariat signé (confirmation manuelle)</label>
        </fieldset>
        <div className="competition-toolbar"><button className="btn-primary" disabled={busy}>Enregistrer · {saison}</button><button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Annuler</button></div>
      </form>
    </section>}

    {plans && <section className="competition-panel" aria-labelledby="competition-import-title">
      <h2 id="competition-import-title">Prévisualisation · saison {saison}</h2>
      <p>{plans.filter((p) => p.action === "creation").length} création(s), {plans.filter((p) => p.action === "modification").length} modification(s), {plans.filter((p) => p.action === "identique").length} inchangée(s). Aucune suppression.</p>
      <p>Sans colonne « Partenariat signé », les signatures existantes sont conservées. Si elle est présente, ses valeurs Oui/Non les remplacent.</p>
      <div className="competition-scroll"><table><caption>Fiches à importer · différences avant → après</caption><thead><tr>{Object.values(LABELS).map((label) => <th key={label}>{label}</th>)}<th>Partenariat signé</th><th>Action</th></tr></thead><tbody>{plans.map((p, i) => <tr key={i}>
        {(Object.keys(LABELS) as (keyof AmbassadeurFields)[]).map((key) => <td key={key}>{p.before && p.before[key] !== p.row[key] ? <><span>Avant : {p.before[key] || "(vide)"}</span><br /><strong>Après : {p.row[key] || "(vide)"}</strong></> : p.row[key] || "(vide)"}</td>)}
        <td>{p.before && p.row.partenariatSigne !== undefined && p.before.partenariatSigne !== p.row.partenariatSigne ? `Avant : ${p.before.partenariatSigne ? "Oui" : "Non"} → Après : ${p.row.partenariatSigne ? "Oui" : "Non"}` : (p.row.partenariatSigne ?? p.before?.partenariatSigne ?? false) ? "Oui" : "Non"}</td><td>{p.action}</td>
      </tr>)}</tbody></table></div>
      <label className="competition-check"><input type="checkbox" disabled={busy} checked={confirmation} onChange={(e) => setConfirmation(e.target.checked)} /> Je confirme la saison {saison} et ces modifications, y compris les signatures présentes dans le fichier.</label>
      <div className="competition-toolbar"><button className="btn-primary" disabled={busy || !confirmation} onClick={() => void operation(async () => {
        const result = await importRows({ saison, plans }); setPlans(null); setConfirmation(false); setCursor(null); setPageNumber(1);
        setMessage(`Import terminé : ${result.created} créée(s), ${result.updated} modifiée(s), ${result.unchanged} inchangée(s).`);
      })}>Confirmer l’import · {saison}</button><button className="btn-secondary" disabled={busy} onClick={() => setPlans(null)}>Annuler</button></div>
    </section>}

    {deleting && <section className="competition-panel" aria-labelledby="competition-delete-title">
      <h2 id="competition-delete-title">Supprimer cette fiche ?</h2><p>{deleting.nom} {deleting.prenom} · {saison}. Cette suppression est définitive.</p>
      <div className="competition-toolbar"><button className="btn-danger" disabled={busy} onClick={() => void operation(async () => {
        await remove({ saison, id: deleting._id, revision: deleting.revision }); setDeleting(null); setMessage("Fiche supprimée.");
      })}>Confirmer la suppression</button><button className="btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>Annuler</button></div>
    </section>}

    <section aria-label="Liste des ambassadeurs">
      <div className="competition-filters">
        <label>Rechercher (nom, email, catégorie)<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>Groupe<select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Tous les groupes</option>{groups.filter(Boolean).map((g) => <option key={g}>{g}</option>)}</select></label>
        <label>Partenariat signé<select value={signed} onChange={(e) => setSigned(e.target.value)}><option value="">Tous</option><option value="oui">Signé</option><option value="non">Non signé</option></select></label>
      </div>
      <p>Recherche et filtres portent sur la page affichée (50 fiches maximum). L’export inclut toute la saison, sans ces filtres. {visible.length} résultat(s).</p>
      {page === undefined ? <p role="status">Chargement…</p> : visible.length === 0 ? <p>Aucun ambassadeur sur cette page pour ces critères.</p> : <div className="competition-scroll"><table>
        <caption>Ambassadeurs · {saison}</caption>
        <thead><tr><th>Nom</th><th>Prénom</th><th>Naissance</th><th>Civilité</th><th>Catégories</th><th>Colonne 1</th><th>Quels groupe</th><th>Email</th><th>Partenariat signé</th><th>Actions</th></tr></thead>
        <tbody>{visible.map((r) => <tr key={r._id}><td>{r.nom}</td><td>{r.prenom}</td><td>{r.dateNaissance.split("-").reverse().join("/")}</td><td>{r.civilite}</td><td>{r.categories}</td><td>{r.colonne1}</td><td>{r.groupe}</td><td>{r.email}</td><td>{r.partenariatSigne ? "Oui" : "Non"}</td><td><div className="competition-row-actions"><button className="btn-secondary" disabled={busy} aria-label={`Modifier ${r.prenom} ${r.nom}`} onClick={() => openForm(r)}>Modifier</button><button className="btn-secondary" disabled={busy} aria-label={`Supprimer ${r.prenom} ${r.nom}`} onClick={() => { setDeleting(r); setEditing(null); setPlans(null); }}>Supprimer</button></div></td></tr>)}</tbody>
      </table></div>}
      <div className="competition-toolbar">
        <button className="btn-secondary" disabled={busy || cursor === null} onClick={() => { setCursor(null); setPageNumber(1); setGroup(""); }}>Première page</button>
        <span>Page {pageNumber}</span>
        <button className="btn-secondary" disabled={busy || !page || page.isDone} onClick={() => { if (page) { setPageNumber(pageNumber + 1); setCursor(page.continueCursor); setGroup(""); } }}>Page suivante</button>
      </div>
    </section>
  </div>;
}
