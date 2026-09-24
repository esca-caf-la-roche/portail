import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Plus, CalendarDays, Save } from "lucide-react";
import { useSeason } from "../../contexts/SeasonContext";
import CoursFormModal, {
  type CoursRow,
  type CoursType,
  type CoursPrefill,
} from "../../components/Budget/CoursFormModal";
import { JOURS } from "../../utils/planning";
import type { Id } from "../../../convex/_generated/dataModel";

const eur0 = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

// Palette stable assignée par TYPE de cours (nom) pour colorer les barres du Gantt.
const PALETTE = [
  "#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed",
  "#0891b2", "#dc2626", "#65a30d", "#9333ea", "#0d9488",
  "#ca8a04", "#be123c", "#4f46e5", "#0369a1", "#15803d",
];

/** "18:30" -> 18.5 (heures décimales). */
function toDecimal(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return (h || 0) + (m || 0) / 60;
}

/** 18.5 -> "18h30" pour l'affichage. */
function fmtHeure(dec: number): string {
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

interface Props {
  isAdmin: boolean;
}

type CoursDisplay = {
  _id: string;
  nom: string;
  tarifAnnuel: number;
  lienPaiementCB?: string;
  nbElevesMax: number;
  nbSemaines: number;
  competition: boolean;
  analytiqueId?: Id<"analytiques">;
  moniteurs: Array<{ salarieId: Id<"salaries">; nbSemaines: number; nom: string }>;
  seances: Array<{ jour: number; heureDebut: string; dureeHeures: number }>;
};

export default function PlanningCours({ isAdmin }: Props) {
  const { season } = useSeason();
  const data = useQuery(api.cours.getPlanning, { saison: season });
  const analytiques = useQuery(api.analytiques.get);
  const reprendrePlanning = useMutation(api.cours.reprendrePlanningSaisonPrecedente);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [coursToEdit, setCoursToEdit] = useState<CoursRow | null>(null);
  const [prefill, setPrefill] = useState<CoursPrefill | null>(null);
  const [reprise, setReprise] = useState(false);
  const [autoSeason, setAutoSeason] = useState<string | null>(null);

  const cours = useMemo(() => (data?.cours ?? []) as CoursDisplay[], [data]);
  const moniteurs = useMemo(
    () => (data?.salaries ?? []).map((s) => ({ salarieId: s.salarieId, nom: s.nom })),
    [data]
  );
  // Ordre d'affichage des moniteurs (issu de la masse salariale).
  const ordreById = useMemo(() => {
    const map = new Map<string, number>();
    (data?.salaries ?? []).forEach((s, i) => map.set(s.salarieId, i));
    return map;
  }, [data]);

  // Reprise automatique du planning si la saison est vide (comme la masse salariale).
  useEffect(() => {
    if (
      isAdmin &&
      data !== undefined &&
      data.cours.length === 0 &&
      (data.prevCoursCount ?? 0) > 0 &&
      !reprise &&
      autoSeason !== season
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoSeason(season);
      setReprise(true);
      void reprendrePlanning({ saison: season })
        .catch((err) => console.error(err))
        .finally(() => setReprise(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, data, season]);

  // Couleur par type de cours (nom).
  const colorByNom = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const c of cours) {
      if (!map.has(c.nom)) map.set(c.nom, PALETTE[i++ % PALETTE.length]);
    }
    return map;
  }, [cours]);

  // Types de cours distincts (gabarit) pour le menu déroulant du modal et le tableau.
  const coursTypes = useMemo<CoursType[]>(() => {
    const map = new Map<string, CoursType>();
    for (const c of cours) {
      if (!map.has(c.nom)) {
        map.set(c.nom, {
          nom: c.nom,
          tarifAnnuel: c.tarifAnnuel,
          nbElevesMax: c.nbElevesMax,
          nbSemaines: c.nbSemaines,
          competition: c.competition,
          analytiqueId: c.analytiqueId,
          seances: c.seances,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.nom.localeCompare(b.nom));
  }, [cours]);

  // Agrégat par type pour le tableau (gabarit + nb de créneaux).
  const typeRows = useMemo(() => {
    const map = new Map<string, { type: CoursType; nbCreneaux: number }>();
    for (const c of cours) {
      const ex = map.get(c.nom);
      if (ex) ex.nbCreneaux += 1;
      else
        map.set(c.nom, {
          type: { nom: c.nom, tarifAnnuel: c.tarifAnnuel, nbElevesMax: c.nbElevesMax, nbSemaines: c.nbSemaines, competition: c.competition, analytiqueId: c.analytiqueId, seances: c.seances },
          nbCreneaux: 1,
        });
    }
    return [...map.values()].sort((a, b) => a.type.nom.localeCompare(b.type.nom));
  }, [cours]);

  const coursById = useMemo(() => {
    const map = new Map<string, CoursDisplay>();
    for (const c of cours) map.set(c._id, c);
    return map;
  }, [cours]);

  // Construction du Gantt par jour. Une LIGNE = un ensemble de moniteurs (un moniteur
  // seul, ou le groupe pour un cours co-encadré → une seule ligne pour les co-moniteurs).
  const planningParJour = useMemo(() => {
    const jours: JourData[] = [];

    for (let j = 0; j < 7; j++) {
      const items: GanttItem[] = [];
      for (const c of cours) {
        const salarieIds = c.moniteurs.map((m) => m.salarieId);
        const rowKey = [...salarieIds].sort().join("|");
        const label = c.moniteurs.map((m) => m.nom).join(" / ");
        for (const s of c.seances) {
          if (s.jour !== j) continue;
          const debut = toDecimal(s.heureDebut);
          items.push({
            coursId: c._id,
            coursNom: c.nom,
            rowKey,
            rowLabel: label,
            salarieIds,
            jour: j,
            debut,
            fin: debut + s.dureeHeures,
            color: colorByNom.get(c.nom) ?? PALETTE[0],
          });
        }
      }
      if (items.length === 0) continue;

      // Lignes distinctes (par ensemble de moniteurs), triées via l'ordre masse salariale.
      const rowsMap = new Map<string, GanttRow>();
      for (const it of items) {
        if (!rowsMap.has(it.rowKey)) {
          const minOrdre = Math.min(...it.salarieIds.map((id) => ordreById.get(id) ?? 999));
          rowsMap.set(it.rowKey, { key: it.rowKey, label: it.rowLabel, salarieIds: it.salarieIds, minOrdre });
        }
      }
      const rows = [...rowsMap.values()].sort((a, b) => a.minOrdre - b.minOrdre || a.label.localeCompare(b.label));

      const min = Math.floor(Math.min(...items.map((it) => it.debut)));
      const max = Math.ceil(Math.max(...items.map((it) => it.fin)));
      jours.push({ jour: j, items, rows, min, max });
    }
    return jours;
  }, [cours, ordreById, colorByNom]);

  const openEditById = (coursId: string) => {
    const c = coursById.get(coursId);
    if (!c) return;
    setPrefill(null);
    setCoursToEdit({
      _id: c._id as Id<"cours">,
      nom: c.nom,
      tarifAnnuel: c.tarifAnnuel,
      lienPaiementCB: c.lienPaiementCB,
      nbElevesMax: c.nbElevesMax,
      nbSemaines: c.nbSemaines,
      competition: c.competition,
      moniteurs: c.moniteurs.map((m) => ({ salarieId: m.salarieId, nbSemaines: m.nbSemaines })),
      seances: c.seances,
    });
    setIsModalOpen(true);
  };

  const openNew = (pf?: CoursPrefill) => {
    setCoursToEdit(null);
    setPrefill(pf ?? null);
    setIsModalOpen(true);
  };

  if (data === undefined) return <div className="loading">Chargement du planning…</div>;

  return (
    <>
      {isAdmin && moniteurs.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", marginBottom: "1.5rem" }}>
          <button className="btn-primary" style={{ width: "auto" }} onClick={() => openNew()}>
            <Plus size={18} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} /> Créneau
          </button>
        </div>
      )}

      {moniteurs.length === 0 ? (
        <section className="card glass-card">
          <p style={{ color: "#9ca3af", fontStyle: "italic", margin: 0 }}>
            Aucun moniteur pour la saison {season}. Ajoutez d'abord des moniteurs dans
            l'onglet « Masse salariale » pour pouvoir créer des cours.
          </p>
        </section>
      ) : reprise ? (
        <div className="loading">Reprise du planning de la saison précédente…</div>
      ) : cours.length === 0 ? (
        <section className="card glass-card">
          <div className="empty-state" style={{ textAlign: "center" }}>
            <p style={{ marginBottom: isAdmin ? "1rem" : 0 }}>
              Aucun cours enregistré pour la saison <strong>{season}</strong>.
            </p>
            {isAdmin && (
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
                {(data.prevCoursCount ?? 0) > 0 && (
                  <button
                    className="btn-primary"
                    style={{ width: "auto" }}
                    onClick={async () => {
                      setReprise(true);
                      try {
                        const res = await reprendrePlanning({ saison: season });
                        if (res.copiees === 0) alert(res.message);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : "Erreur lors de la reprise.");
                      } finally {
                        setReprise(false);
                      }
                    }}
                  >
                    <Plus size={16} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} /> Reprendre la saison précédente
                  </button>
                )}
                <button className="btn-secondary" style={{ width: "auto" }} onClick={() => openNew()}>
                  <Plus size={16} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} /> Ajouter un créneau
                </button>
              </div>
            )}
          </div>
        </section>
      ) : (
        <>
          {isAdmin && (
            <p style={{ color: "#6b7280", fontSize: "0.85rem", margin: "0 0 0.75rem" }}>
              Survolez un créneau pour le détail · cliquez pour le modifier · utilisez les « + » pour ajouter.
            </p>
          )}
          {planningParJour.map((jourData) => (
            <GanttJour
              key={jourData.jour}
              jourData={jourData}
              coursById={coursById}
              isAdmin={isAdmin}
              onEdit={openEditById}
              onAdd={openNew}
            />
          ))}

          {/* Tableau par TYPE de cours (cascade) */}
          <section className="card glass-card" style={{ marginTop: "2rem", overflowX: "auto" }}>
            <h2 style={{ marginBottom: "1rem" }}>Types de cours</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "720px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Type de cours</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Analytique</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Compétition&nbsp;?</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Tarif/an (€)</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Élèves max</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Semaines</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Séances/sem</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>h/sem</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Créneaux</th>
                  {isAdmin && <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}></th>}
                </tr>
              </thead>
              <tbody>
                {typeRows.map(({ type, nbCreneaux }) => (
                  <TypeRow
                    key={type.nom}
                    saison={season}
                    type={type}
                    nbCreneaux={nbCreneaux}
                    color={colorByNom.get(type.nom)}
                    analytiques={analytiques ?? []}
                    isAdmin={isAdmin}
                  />
                ))}
              </tbody>
            </table>
            <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: "0.75rem", marginBottom: 0 }}>
              Le tarif, le nombre d'élèves, de semaines et l'analytique sont communs à tous les
              créneaux d'un même type (cascade). Les jours/horaires, durées et moniteurs se modifient
              sur chaque créneau (clic dans le diagramme). L'analytique alimente automatiquement une
              ligne d'inscription dans le prévisionnel (1 par analytique = Σ tarif × élèves max).
            </p>
          </section>
        </>
      )}

      <CoursFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        coursToEdit={coursToEdit}
        moniteurs={moniteurs}
        coursTypes={coursTypes}
        prefill={prefill}
      />
    </>
  );
}

/** Ligne du tableau « types de cours » : tarif/élèves/semaines éditables (cascade). */
function TypeRow({
  saison,
  type,
  nbCreneaux,
  color,
  analytiques,
  isAdmin,
}: {
  saison: string;
  type: CoursType;
  nbCreneaux: number;
  color?: string;
  analytiques: Array<{ _id: Id<"analytiques">; nom: string }>;
  isAdmin: boolean;
}) {
  const updateTypeCours = useMutation(api.cours.updateTypeCours);
  const [tarif, setTarif] = useState(String(type.tarifAnnuel));
  const [eleves, setEleves] = useState(String(type.nbElevesMax));
  const [semaines, setSemaines] = useState(String(type.nbSemaines));
  const [competition, setCompetition] = useState(type.competition);
  const [analytiqueId, setAnalytiqueId] = useState<string>(type.analytiqueId ?? "");
  const [saving, setSaving] = useState(false);

  // Re-synchronise quand les données changent (cascade, autre client…).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setTarif(String(type.tarifAnnuel));
    setEleves(String(type.nbElevesMax));
    setSemaines(String(type.nbSemaines));
    setCompetition(type.competition);
    setAnalytiqueId(type.analytiqueId ?? "");
  }, [type.tarifAnnuel, type.nbElevesMax, type.nbSemaines, type.competition, type.analytiqueId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const dirty =
    parseFloat(tarif) !== type.tarifAnnuel ||
    parseInt(eleves, 10) !== type.nbElevesMax ||
    parseInt(semaines, 10) !== type.nbSemaines ||
    competition !== type.competition ||
    analytiqueId !== (type.analytiqueId ?? "");

  const hSem = type.seances.reduce((a, s) => a + s.dureeHeures, 0);

  const save = async () => {
    setSaving(true);
    try {
      await updateTypeCours({
        saison,
        nom: type.nom,
        tarifAnnuel: parseFloat(tarif) || 0,
        nbElevesMax: parseInt(eleves, 10) || 0,
        nbSemaines: parseInt(semaines, 10) || 0,
        competition,
        analytiqueId: analytiqueId ? (analytiqueId as Id<"analytiques">) : null,
      });
    } catch (err) {
      console.error(err);
      alert("Erreur lors de l'enregistrement du type de cours.");
    } finally {
      setSaving(false);
    }
  };

  const cell: CSSProperties = { padding: "0.5rem 0.5rem", textAlign: "right" };
  const inputStyle: CSSProperties = { width: 80, textAlign: "right", margin: 0, padding: "0.3rem 0.4rem" };

  return (
    <tr style={{ borderBottom: "1px solid #f0f0f0" }}>
      <td style={{ padding: "0.5rem 0.5rem" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 8, backgroundColor: color }} />
        <strong>{type.nom}</strong>
      </td>
      <td style={{ padding: "0.5rem 0.5rem" }}>
        {isAdmin ? (
          <select
            className="input-field"
            style={{ margin: 0, padding: "0.3rem 0.4rem", minWidth: 150 }}
            value={analytiqueId}
            onChange={(e) => setAnalytiqueId(e.target.value)}
            title="Analytique pour la ligne d'inscription du prévisionnel"
          >
            <option value="">— Aucune —</option>
            {analytiques.map((a) => (
              <option key={a._id} value={a._id}>{a.nom}</option>
            ))}
          </select>
        ) : (
          <span style={{ color: "#6b7280" }}>
            {analytiques.find((a) => a._id === type.analytiqueId)?.nom ?? "—"}
          </span>
        )}
      </td>
      <td style={{ padding: "0.5rem 0.5rem" }}>
        {isAdmin ? (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input type="checkbox" checked={competition} onChange={(e) => setCompetition(e.target.checked)} style={{ width: 16, height: 16 }} />
            {competition && (
              <span className="badge" style={{ fontSize: "0.72rem", backgroundColor: "#fef3c7", color: "#92400e" }}>Compétition</span>
            )}
          </label>
        ) : competition ? (
          <span className="badge" style={{ fontSize: "0.72rem", backgroundColor: "#fef3c7", color: "#92400e" }}>Compétition</span>
        ) : null}
      </td>
      <td style={cell}>
        {isAdmin ? (
          <input type="number" step="0.01" className="input-field" style={inputStyle} value={tarif} onChange={(e) => setTarif(e.target.value)} />
        ) : (
          <span className="font-mono">{eur0(type.tarifAnnuel)}</span>
        )}
      </td>
      <td style={cell}>
        {isAdmin ? (
          <input type="number" step="1" className="input-field" style={inputStyle} value={eleves} onChange={(e) => setEleves(e.target.value)} />
        ) : (
          <span className="font-mono">{type.nbElevesMax}</span>
        )}
      </td>
      <td style={cell}>
        {isAdmin ? (
          <input type="number" step="1" className="input-field" style={inputStyle} value={semaines} onChange={(e) => setSemaines(e.target.value)} />
        ) : (
          <span className="font-mono">{type.nbSemaines}</span>
        )}
      </td>
      <td style={cell} className="font-mono">{type.seances.length}</td>
      <td style={cell} className="font-mono">{hSem.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td>
      <td style={cell} className="font-mono">{nbCreneaux}</td>
      {isAdmin && (
        <td style={cell}>
          <button
            className="btn-icon info"
            onClick={save}
            disabled={!dirty || saving}
            title={dirty ? "Enregistrer (cascade sur tous les créneaux)" : "Aucune modification"}
            style={{ opacity: dirty ? 1 : 0.4 }}
          >
            <Save size={16} />
          </button>
        </td>
      )}
    </tr>
  );
}

type GanttItem = {
  coursId: string;
  coursNom: string;
  rowKey: string;
  rowLabel: string;
  salarieIds: Id<"salaries">[];
  jour: number;
  debut: number;
  fin: number;
  color: string;
};
type GanttRow = { key: string; label: string; salarieIds: Id<"salaries">[]; minOrdre: number };
type JourData = { jour: number; items: GanttItem[]; rows: GanttRow[]; min: number; max: number };

/** Une journée du Gantt : lignes = moniteur(s), axe horizontal = horaires. */
function GanttJour({
  jourData,
  coursById,
  isAdmin,
  onEdit,
  onAdd,
}: {
  jourData: JourData;
  coursById: Map<string, CoursDisplay>;
  isAdmin: boolean;
  onEdit: (coursId: string) => void;
  onAdd: (prefill: CoursPrefill) => void;
}) {
  const { jour, items, rows, min, max } = jourData;
  const span = Math.max(max - min, 1);
  const heures: number[] = [];
  for (let h = min; h <= max; h++) heures.push(h);

  const pct = (v: number) => `${((v - min) / span) * 100}%`;
  const LABEL_W = 150;

  const [hover, setHover] = useState<{ item: GanttItem; x: number; y: number } | null>(null);

  return (
    <section className="card glass-card" style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: 0 }}>
          <CalendarDays size={18} /> {JOURS[jour]}
        </h3>
        {isAdmin && (
          <button
            className="btn-secondary"
            style={{ width: "auto", padding: "0.25rem 0.6rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            onClick={() => onAdd({ jour })}
            title="Ajouter un créneau ce jour"
          >
            <Plus size={14} /> Ligne
          </button>
        )}
      </div>

      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 640 }}>
          {/* Axe des heures */}
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }} />
            <div style={{ position: "relative", flex: 1, height: 20 }}>
              {heures.map((h) => (
                <span
                  key={h}
                  style={{
                    position: "absolute",
                    left: pct(h),
                    // La 1re heure s'aligne à gauche, la dernière à droite, le reste centré,
                    // pour éviter que le label déborde (et soit coupé) aux extrémités.
                    transform: h === min ? "translateX(0)" : h === max ? "translateX(-100%)" : "translateX(-50%)",
                    fontSize: "0.72rem",
                    color: "#6b7280",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}h
                </span>
              ))}
            </div>
          </div>

          {/* Une ligne par ensemble de moniteurs */}
          {rows.map((row) => {
            const seances = items.filter((it) => it.rowKey === row.key);
            return (
              <div key={row.key} style={{ display: "flex", alignItems: "center", borderTop: "1px solid #f0f0f0" }}>
                <div style={{ width: LABEL_W, flexShrink: 0, padding: "0.5rem 0.5rem 0.5rem 0", fontWeight: 600, fontSize: "0.85rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
                  {isAdmin && (
                    <button
                      onClick={() => onAdd({ jour, moniteurIds: row.salarieIds })}
                      title="Ajouter un créneau pour ce(s) moniteur(s) ce jour"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#2563eb", display: "flex", flexShrink: 0 }}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                </div>
                <div style={{ position: "relative", flex: 1, height: 44 }}>
                  {heures.map((h) => (
                    <div key={h} style={{ position: "absolute", left: pct(h), top: 0, bottom: 0, width: 1, background: "#f1f5f9" }} />
                  ))}
                  {seances.map((s, i) => (
                    <div
                      key={i}
                      onMouseEnter={(e) => setHover({ item: s, x: e.clientX, y: e.clientY })}
                      onMouseMove={(e) => setHover({ item: s, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => isAdmin && onEdit(s.coursId)}
                      style={{
                        position: "absolute",
                        left: pct(s.debut),
                        width: `${((s.fin - s.debut) / span) * 100}%`,
                        top: 6,
                        height: 32,
                        background: s.color,
                        borderRadius: 6,
                        color: "#fff",
                        fontSize: "0.74rem",
                        display: "flex",
                        alignItems: "center",
                        padding: "0 0.4rem",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
                        cursor: isAdmin ? "pointer" : "default",
                      }}
                    >
                      {s.coursNom}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hover && <GanttTooltip hover={hover} cours={coursById.get(hover.item.coursId)} />}
    </section>
  );
}

/** Info-bulle affichant toutes les informations d'un créneau survolé. */
function GanttTooltip({
  hover,
  cours,
}: {
  hover: { item: GanttItem; x: number; y: number };
  cours: CoursDisplay | undefined;
}) {
  if (!cours) return null;
  const { item } = hover;
  const left = Math.min(hover.x + 14, window.innerWidth - 280);
  const top = Math.min(hover.y + 14, window.innerHeight - 240);

  return (
    <div style={{ position: "fixed", left, top, zIndex: 1000, width: 260, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: "0.75rem 0.85rem", fontSize: "0.8rem", color: "#374151", pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: "0.9rem", marginBottom: 6 }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: item.color }} />
        {cours.nom}
      </div>
      <TipLine label="Créneau survolé" value={`${JOURS[item.jour]} · ${fmtHeure(item.debut)}–${fmtHeure(item.fin)}`} />
      <TipLine label="Tarif annuel" value={eur0(cours.tarifAnnuel)} />
      <TipLine label="Élèves max" value={String(cours.nbElevesMax)} />
      <TipLine label="Semaines" value={String(cours.nbSemaines)} />
      <TipLine label="Séances/sem." value={String(cours.seances.length)} />
      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #f0f0f0" }}>
        <div style={{ color: "#6b7280", marginBottom: 2 }}>Séances :</div>
        {cours.seances.map((s, i) => (
          <div key={i}>{JOURS[s.jour]} {fmtHeure(toDecimal(s.heureDebut))} · {s.dureeHeures} h</div>
        ))}
      </div>
      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #f0f0f0" }}>
        <div style={{ color: "#6b7280", marginBottom: 2 }}>Moniteur(s) :</div>
        {cours.moniteurs.map((m, i) => (
          <div key={i}>
            {m.nom}
            {cours.moniteurs.length > 1 && (
              <span style={{ color: "#9ca3af" }}> ({m.nbSemaines.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} sem.)</span>
            )}
          </div>
        ))}
      </div>
      {cours.lienPaiementCB && <div style={{ marginTop: 6, color: "#2563eb", wordBreak: "break-all" }}>{cours.lienPaiementCB}</div>}
    </div>
  );
}

function TipLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
