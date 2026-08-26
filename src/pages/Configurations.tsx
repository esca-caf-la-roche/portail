import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Save, Star, Trash2, Users, Calendar, Plus, LayoutDashboard } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import UsersAccessPanel from "../components/Configurations/UsersAccessPanel";
import DashboardTilesPanel from "../components/Configurations/DashboardTilesPanel";

/** Message d'erreur lisible : privilégie la charge utile d'une ConvexError
 * (error.data), transmise même en production, sinon retombe sur error.message. */
function errMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown })?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && msg ? msg : fallback;
}

/** Saison suivante au format "YYYY-YY" (ex: "2026-27" -> "2027-28"). */
function nextSaisonLabel(noms: string[]): string | null {
  const latest = noms.filter((n) => /^\d{4}-\d{2}$/.test(n)).sort((a, b) => b.localeCompare(a))[0];
  if (!latest) return null;
  const start = parseInt(latest.slice(0, 4), 10) + 1;
  return `${start}-${((start + 1) % 100).toString().padStart(2, "0")}`;
}

export default function Configurations() {
  const [activeTab, setActiveTab] = useState<"saisons" | "utilisateurs" | "tableau-de-bord">("saisons");

  // Saisons
  const saisons = useQuery(api.saisons.get);
  const createSaison = useMutation(api.saisons.create);
  const createNextSaison = useMutation(api.saisons.createNext);
  const updateSaison = useMutation(api.saisons.update);
  const removeSaison = useMutation(api.saisons.remove);
  const [newSaisonName, setNewSaisonName] = useState("");
  const [isSubmittingSaison, setIsSubmittingSaison] = useState(false);

  // Saisons handlers
  const handleCreateNext = async () => {
    setIsSubmittingSaison(true);
    try {
      const res = await createNextSaison({});
      alert(`Saison ${res.nom} créée (${res.lignesReprises} moniteurs repris de la saison précédente).`);
    } catch (err) {
      console.error(err);
      alert(errMessage(err, "Erreur lors de la création."));
    } finally {
      setIsSubmittingSaison(false);
    }
  };

  const handleAddSaison = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newSaisonName.trim();
    if (!name) return;

    if (saisons?.some(s => s.nom === name)) {
      alert("Cette saison existe déjà.");
      return;
    }

    setIsSubmittingSaison(true);
    try {
      await createSaison({ nom: name, isDefault: false });
      setNewSaisonName("");
    } catch (err) {
      console.error(err);
      alert("Erreur lors de l'ajout.");
    } finally {
      setIsSubmittingSaison(false);
    }
  };

  const handleSetDefault = async (id: Id<"saisons">) => {
    try {
      await updateSaison({ id, isDefault: true });
    } catch (err) {
      console.error(err);
      alert("Erreur lors de la mise à jour.");
    }
  };

  const handleDeleteSaison = async (id: Id<"saisons">) => {
    if (window.confirm("Êtes-vous sûr de vouloir supprimer cette saison ? Elle ne doit contenir aucune donnée.")) {
      try {
        await removeSaison({ id });
      } catch (err) {
        console.error(err);
        alert(errMessage(err, "Erreur lors de la suppression."));
      }
    }
  };

  return (
    <div className="configurations-page fade-in">
      <header className="page-header" style={{ marginBottom: "2rem" }}>
        <h1>Configurations</h1>
        <p className="subtitle">Gérez les paramètres globaux de l'application.</p>
      </header>

      <div className="configurations-tabs" aria-label="Sections de configuration">
        <button 
          type="button"
          aria-pressed={activeTab === "saisons"}
          className={activeTab === "saisons" ? "is-active" : ""}
          onClick={() => setActiveTab("saisons")}
        >
          <Calendar size={18} /> Saisons
        </button>
        <button 
          type="button"
          aria-pressed={activeTab === "utilisateurs"}
          className={activeTab === "utilisateurs" ? "is-active" : ""}
          onClick={() => setActiveTab("utilisateurs")}
        >
          <Users size={18} /> Utilisateurs et Accès
        </button>
        <button
          type="button"
          aria-pressed={activeTab === "tableau-de-bord"}
          className={activeTab === "tableau-de-bord" ? "is-active" : ""}
          onClick={() => setActiveTab("tableau-de-bord")}
        >
          <LayoutDashboard size={18} /> Tableau de bord
        </button>
      </div>

      {activeTab === "saisons" && (
        <div className="tab-content fade-in">
          <div className="card glass-card" style={{ marginBottom: "2rem" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
              <Calendar size={20} /> Ajouter la saison suivante
            </h2>
            <p style={{ color: "#6b7280", marginBottom: "1rem", fontSize: "0.95rem" }}>
              La nouvelle saison suit automatiquement la dernière (ex&nbsp;:
              {saisons && nextSaisonLabel(saisons.map(s => s.nom)) ? ` ${nextSaisonLabel(saisons.map(s => s.nom))}` : ""})
              et reprend les paramètres de paie et les moniteurs de la saison précédente
              (vous ajusterez ensuite les augmentations dans le Budget).
            </p>
            <button
              type="button"
              className="btn-primary"
              disabled={isSubmittingSaison || !saisons || saisons.length === 0}
              onClick={handleCreateNext}
              style={{ whiteSpace: "nowrap", alignSelf: "flex-start" }}
            >
              <Plus size={16} style={{ marginRight: "0.5rem" }} />
              {saisons && nextSaisonLabel(saisons.map(s => s.nom))
                ? `Créer la saison ${nextSaisonLabel(saisons.map(s => s.nom))}`
                : "Créer la saison suivante"}
            </button>

            <details style={{ marginTop: "1.25rem" }}>
              <summary style={{ cursor: "pointer", color: "#6b7280", fontSize: "0.9rem" }}>
                Ajouter une saison avec un nom personnalisé
              </summary>
              <form onSubmit={handleAddSaison} style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
                <div style={{ width: "100%" }}>
                  <label className="form-label">Nom de la saison (ex: 2027-28)</label>
                  <input
                    type="text"
                    className="input-field"
                    placeholder="Ex: 2027-28"
                    value={newSaisonName}
                    onChange={e => setNewSaisonName(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <button type="submit" className="btn-secondary" disabled={isSubmittingSaison} style={{ whiteSpace: "nowrap", alignSelf: "flex-start" }}>
                  <Save size={16} style={{ marginRight: "0.5rem" }} /> Ajouter
                </button>
              </form>
            </details>
          </div>

          <div className="card glass-card">
            <h2 style={{ marginBottom: "1rem" }}>Saisons existantes</h2>
            {saisons === undefined ? (
              <div>Chargement...</div>
            ) : (
              <div className="saisons-list" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {saisons.map((saison) => (
                  <div key={saison._id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", backgroundColor: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
                    <span style={{ fontWeight: "bold", fontSize: "1.1rem" }}>{saison.nom}</span>
                    
                    <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                      {saison.isDefault ? (
                        <span className="badge" style={{ backgroundColor: "#fef08a", color: "#854d0e", display: "flex", alignItems: "center", gap: "0.25rem", boxShadow: "2px 2px 0px 0px #000" }}>
                          <Star size={14} fill="currentColor" /> Par défaut
                        </span>
                      ) : (
                        <button 
                          className="btn-secondary info" 
                          onClick={() => handleSetDefault(saison._id)}
                          style={{ padding: "0.5rem 1rem", fontSize: "0.9rem" }}
                        >
                          Définir par défaut
                        </button>
                      )}
                      
                      {!saison.isDefault && (
                        <button 
                          className="btn-icon danger" 
                          onClick={() => handleDeleteSaison(saison._id)}
                          title="Supprimer"
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "utilisateurs" && (
        <div className="tab-content fade-in">
          <UsersAccessPanel />
        </div>
      )}

      {activeTab === "tableau-de-bord" && <DashboardTilesPanel />}
    </div>
  );
}
