import React, { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { X, Save, Plus, Trash2 } from "lucide-react";
import { useSeason } from "../../contexts/SeasonContext";
import { JOURS } from "../../utils/planning";
import type { Id } from "../../../convex/_generated/dataModel";

export interface Seance {
  jour: number;
  heureDebut: string;
  dureeHeures: number;
}

export interface CoursMoniteur {
  salarieId: Id<"salaries">;
  nbSemaines: number;
}

export interface CoursRow {
  _id: Id<"cours">;
  nom: string;
  tarifAnnuel: number;
  lienPaiementCB?: string;
  nbElevesMax: number;
  nbSemaines: number;
  competition: boolean;
  moniteurs: CoursMoniteur[];
  seances: Seance[];
}

/** Gabarit partagé d'un type de cours (pour le menu déroulant + préremplissage). */
export interface CoursType {
  nom: string;
  tarifAnnuel: number;
  nbElevesMax: number;
  nbSemaines: number;
  competition: boolean;
  analytiqueId?: Id<"analytiques">;
  seances: Seance[];
}

interface MoniteurOption {
  salarieId: Id<"salaries">;
  nom: string;
}

export interface CoursPrefill {
  jour?: number;
  moniteurIds?: Id<"salaries">[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  coursToEdit?: CoursRow | null;
  moniteurs: MoniteurOption[];
  coursTypes: CoursType[];
  prefill?: CoursPrefill | null;
}

type SeanceForm = { jour: number; heureDebut: string; dureeHeures: string };

const NEW_TYPE = "__new__";
const emptySeance = (jour = 0): SeanceForm => ({ jour, heureDebut: "18:00", dureeHeures: "1.5" });

export default function CoursFormModal({ isOpen, onClose, coursToEdit, moniteurs, coursTypes, prefill }: Props) {
  const { season } = useSeason();
  const addCours = useMutation(api.cours.addCours);
  const updateCours = useMutation(api.cours.updateCours);
  const removeCours = useMutation(api.cours.removeCours);

  const [nomChoice, setNomChoice] = useState(""); // nom de type sélectionné, "" ou NEW_TYPE
  const [nomNew, setNomNew] = useState(""); // nom saisi quand "Nouveau type"
  const [tarifAnnuel, setTarifAnnuel] = useState("");
  const [lienPaiementCB, setLienPaiementCB] = useState("");
  const [nbElevesMax, setNbElevesMax] = useState("");
  const [nbSemaines, setNbSemaines] = useState("");
  const [competition, setCompetition] = useState(false);
  const [moniteurIds, setMoniteurIds] = useState<string[]>([]);
  const [seances, setSeances] = useState<SeanceForm[]>([emptySeance()]);
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen) return;
    if (coursToEdit) {
      setNomChoice(coursToEdit.nom);
      setNomNew("");
      setTarifAnnuel(String(coursToEdit.tarifAnnuel));
      setLienPaiementCB(coursToEdit.lienPaiementCB ?? "");
      setNbElevesMax(String(coursToEdit.nbElevesMax));
      setNbSemaines(String(coursToEdit.nbSemaines));
      setCompetition(coursToEdit.competition);
      setMoniteurIds(coursToEdit.moniteurs.map((m) => m.salarieId));
      setSeances(
        coursToEdit.seances.map((s) => ({ jour: s.jour, heureDebut: s.heureDebut, dureeHeures: String(s.dureeHeures) }))
      );
    } else {
      setNomChoice("");
      setNomNew("");
      setTarifAnnuel("");
      setLienPaiementCB("");
      setNbElevesMax("");
      setNbSemaines("");
      setCompetition(false);
      setMoniteurIds(
        prefill?.moniteurIds && prefill.moniteurIds.length > 0
          ? prefill.moniteurIds
          : [moniteurs[0]?.salarieId ?? ""]
      );
      setSeances([emptySeance(prefill?.jour ?? 0)]);
    }
  }, [isOpen, coursToEdit, moniteurs, prefill]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!isOpen) return null;

  // Sélection d'un type existant => préremplit tarif / élèves / semaines / séances.
  const onSelectType = (value: string) => {
    setNomChoice(value);
    if (value === NEW_TYPE || value === "") return;
    const t = coursTypes.find((c) => c.nom === value);
    if (t) {
      setTarifAnnuel(String(t.tarifAnnuel));
      setNbElevesMax(String(t.nbElevesMax));
      setNbSemaines(String(t.nbSemaines));
      setCompetition(t.competition);
      setSeances(
        t.seances.map((s) => ({ jour: s.jour, heureDebut: s.heureDebut, dureeHeures: String(s.dureeHeures) }))
      );
    }
  };

  const updateSeance = (idx: number, patch: Partial<SeanceForm>) =>
    setSeances((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  const addSeance = () => setSeances((prev) => [...prev, emptySeance()]);
  const removeSeance = (idx: number) =>
    setSeances((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));

  const updateMoniteur = (idx: number, value: string) =>
    setMoniteurIds((prev) => prev.map((m, i) => (i === idx ? value : m)));
  const addMoniteur = () => setMoniteurIds((prev) => [...prev, moniteurs[0]?.salarieId ?? ""]);
  const removeMoniteur = (idx: number) =>
    setMoniteurIds((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));

  const nomEffectif = nomChoice === NEW_TYPE ? nomNew.trim() : nomChoice;
  const moniteursValides = moniteurIds.filter(Boolean);
  const nbSemainesNum = parseInt(nbSemaines, 10) || 0;
  const partSemaines = moniteursValides.length > 0 ? nbSemainesNum / moniteursValides.length : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nomEffectif || !nbElevesMax || !tarifAnnuel || !nbSemaines) {
      alert("Veuillez remplir le nom, le tarif, le nombre d'élèves et de semaines.");
      return;
    }
    const parsedSeances = seances
      .filter((s) => s.heureDebut && s.dureeHeures)
      .map((s) => ({ jour: s.jour, heureDebut: s.heureDebut, dureeHeures: parseFloat(s.dureeHeures) }));
    if (parsedSeances.length === 0) {
      alert("Ajoutez au moins une séance valide (jour, heure, durée).");
      return;
    }
    if (moniteursValides.length === 0) {
      alert("Ajoutez au moins un moniteur.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        nom: nomEffectif,
        tarifAnnuel: parseFloat(tarifAnnuel),
        lienPaiementCB: lienPaiementCB.trim() || undefined,
        nbElevesMax: parseInt(nbElevesMax, 10),
        nbSemaines: nbSemainesNum,
        competition,
        moniteurs: moniteursValides as Id<"salaries">[],
        seances: parsedSeances,
      };
      if (coursToEdit) {
        await updateCours({ coursId: coursToEdit._id, ...payload });
      } else {
        await addCours({ saison: season, ...payload });
      }
      onClose();
    } catch (err) {
      console.error(err);
      alert("Une erreur est survenue lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{coursToEdit ? "Modifier le créneau" : "Nouveau créneau"}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Nom = type de cours (liste déroulante + nouveau) */}
          <div className="form-group">
            <label className="form-label" htmlFor="cours-nom">
              Type de cours <span className="text-red-500">*</span>
            </label>
            <select
              id="cours-nom"
              className="input-field"
              value={nomChoice}
              onChange={(e) => onSelectType(e.target.value)}
              required
            >
              <option value="" disabled>Sélectionner un type…</option>
              {coursTypes.map((t) => (
                <option key={t.nom} value={t.nom}>{t.nom}</option>
              ))}
              <option value={NEW_TYPE}>➕ Nouveau type…</option>
            </select>
            {nomChoice === NEW_TYPE && (
              <input
                type="text"
                className="input-field"
                style={{ marginTop: "0.5rem" }}
                value={nomNew}
                onChange={(e) => setNomNew(e.target.value)}
                placeholder="Nom du nouveau type de cours"
                autoFocus
              />
            )}
            {nomChoice && nomChoice !== NEW_TYPE && (
              <p style={{ fontSize: "0.78rem", color: "#6b7280", marginTop: "0.4rem", marginBottom: 0 }}>
                Tarif, élèves max, semaines et séances sont communs à ce type (cascade).
              </p>
            )}
          </div>

          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <div className="form-group" style={{ flex: "1 1 120px" }}>
              <label className="form-label" htmlFor="cours-tarif">Tarif annuel (€) <span className="text-red-500">*</span></label>
              <input id="cours-tarif" type="number" step="0.01" className="input-field" value={tarifAnnuel} onChange={(e) => setTarifAnnuel(e.target.value)} required placeholder="Ex: 280" />
            </div>
            <div className="form-group" style={{ flex: "1 1 120px" }}>
              <label className="form-label" htmlFor="cours-eleves">Nb élèves max <span className="text-red-500">*</span></label>
              <input id="cours-eleves" type="number" step="1" className="input-field" value={nbElevesMax} onChange={(e) => setNbElevesMax(e.target.value)} required placeholder="Ex: 12" />
            </div>
            <div className="form-group" style={{ flex: "1 1 120px" }}>
              <label className="form-label" htmlFor="cours-semaines">Nb semaines <span className="text-red-500">*</span></label>
              <input id="cours-semaines" type="number" step="1" className="input-field" value={nbSemaines} onChange={(e) => setNbSemaines(e.target.value)} required placeholder="Ex: 34" />
            </div>
            <div className="form-group" style={{ flex: "1 1 120px" }}>
              <label className="form-label" htmlFor="cours-competition">Compétition ?</label>
              <label htmlFor="cours-competition" style={{ display: "flex", alignItems: "center", gap: "0.5rem", height: "calc(2.5rem + 2px)", cursor: "pointer" }}>
                <input id="cours-competition" type="checkbox" checked={competition} onChange={(e) => setCompetition(e.target.checked)} style={{ width: 18, height: 18 }} />
                {competition && (
                  <span className="badge" style={{ fontSize: "0.72rem", backgroundColor: "#fef3c7", color: "#92400e" }}>Compétition</span>
                )}
              </label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="cours-lien">Lien paiement CB</label>
            <input id="cours-lien" type="url" className="input-field" value={lienPaiementCB} onChange={(e) => setLienPaiementCB(e.target.value)} placeholder="https://…" />
          </div>

          {/* Moniteurs : liste de moniteurs ; semaines réparties automatiquement */}
          <div className="form-group">
            <label className="form-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Moniteurs <span className="text-red-500">*</span>{" "}
                <span style={{ color: "#6b7280", fontWeight: "normal" }}>
                  ({moniteursValides.length}
                  {moniteursValides.length > 1 ? ` · ≈ ${partSemaines.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} sem./moniteur` : ""})
                </span>
              </span>
              <button type="button" className="btn-secondary" style={{ width: "auto", padding: "0.25rem 0.6rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }} onClick={addMoniteur}>
                <Plus size={14} /> Moniteur
              </button>
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              {moniteurIds.map((id, idx) => (
                <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <select className="input-field" style={{ flex: 1, margin: 0 }} value={id} onChange={(e) => updateMoniteur(idx, e.target.value)}>
                    <option value="" disabled>{moniteurs.length === 0 ? "Aucun moniteur" : "Sélectionner…"}</option>
                    {moniteurs.map((opt) => (
                      <option key={opt.salarieId} value={opt.salarieId}>{opt.nom}</option>
                    ))}
                  </select>
                  <span
                    title="Réparti automatiquement (non modifiable)"
                    style={{ flexShrink: 0, minWidth: 86, textAlign: "right", fontSize: "0.82rem", color: "#6b7280", fontVariantNumeric: "tabular-nums" }}
                  >
                    {partSemaines.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} sem.
                  </span>
                  <button type="button" className="btn-icon danger" onClick={() => removeMoniteur(idx)} title="Retirer le moniteur" disabled={moniteurIds.length <= 1}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <p style={{ fontSize: "0.78rem", color: "#6b7280", marginTop: "0.4rem", marginBottom: 0 }}>
              Plusieurs moniteurs = répartition de l'année (semaines ÷ nombre de moniteurs).
            </p>
          </div>

          {/* Séances par semaine */}
          <div className="form-group">
            <label className="form-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Séances par semaine <span className="text-red-500">*</span>{" "}
                <span style={{ color: "#6b7280", fontWeight: "normal" }}>({seances.length})</span>
              </span>
              <button type="button" className="btn-secondary" style={{ width: "auto", padding: "0.25rem 0.6rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }} onClick={addSeance}>
                <Plus size={14} /> Séance
              </button>
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              {seances.map((s, idx) => (
                <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <select className="input-field" style={{ flex: "1 1 120px", margin: 0 }} value={s.jour} onChange={(e) => updateSeance(idx, { jour: parseInt(e.target.value, 10) })}>
                    {JOURS.map((j, ji) => (<option key={ji} value={ji}>{j}</option>))}
                  </select>
                  <input type="time" className="input-field" style={{ flex: "1 1 110px", margin: 0 }} value={s.heureDebut} onChange={(e) => updateSeance(idx, { heureDebut: e.target.value })} title="Heure de début" />
                  <input type="number" step="0.25" min="0.25" className="input-field" style={{ flex: "1 1 90px", margin: 0 }} value={s.dureeHeures} onChange={(e) => updateSeance(idx, { dureeHeures: e.target.value })} title="Durée (heures)" placeholder="Durée (h)" />
                  <button type="button" className="btn-icon danger" onClick={() => removeSeance(idx)} title="Retirer la séance" disabled={seances.length <= 1}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: "2rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              {coursToEdit && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ width: "auto", color: "#b91c1c", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                  disabled={saving}
                  onClick={async () => {
                    if (!window.confirm(`Supprimer ce créneau de « ${coursToEdit.nom} » ?`)) return;
                    setSaving(true);
                    try {
                      await removeCours({ coursId: coursToEdit._id });
                      onClose();
                    } catch (err) {
                      console.error(err);
                      alert("Erreur lors de la suppression.");
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <Trash2 size={16} /> Supprimer
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button type="button" className="btn-secondary" onClick={onClose}>Annuler</button>
              <button type="submit" className="btn-primary" disabled={saving} style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "auto" }}>
                <Save size={18} /> Enregistrer
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
