import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import {
  Plus, Edit2, Trash2, ChevronDown, ChevronRight,
  Settings2, TrendingUp, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { useSeason } from "../../contexts/SeasonContext";
import {
  computePaie, computeTotaux,
  type ParametresPaie, type SalaireInput, type PaieResult,
} from "../../utils/paieCompute";
import SalarieFormModal, { type SalarieRow } from "../../components/Budget/SalarieFormModal";
import PlanningCours from "./PlanningCours";
import Previsionnel from "../Previsionnel";
import SyntheseCouts from "./SyntheseCouts";

/** Convertit les paramètres bruts (Convex) vers le type de calcul. */
function toParametresPaie(params: {
  margeSecurite: number; indemniteCpPct: number; mutuelleSalarie: number;
  mutuelleEmployeur: number; primeEquipementAnnuelle: number; fraisBulletin: number;
  cotisationsSalariales: Array<{ label: string; taux: number; base: string }>;
  cotisationsPatronales: Array<{ label: string; taux: number }>;
}): ParametresPaie {
  return {
    margeSecurite: params.margeSecurite,
    indemniteCpPct: params.indemniteCpPct,
    mutuelleSalarie: params.mutuelleSalarie,
    mutuelleEmployeur: params.mutuelleEmployeur,
    primeEquipementAnnuelle: params.primeEquipementAnnuelle,
    fraisBulletin: params.fraisBulletin,
    cotisationsSalariales: params.cotisationsSalariales.map((c) => ({
      label: c.label, taux: c.taux, base: c.base as ParametresPaie["cotisationsSalariales"][number]["base"],
    })),
    cotisationsPatronales: params.cotisationsPatronales,
  };
}

const eur = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const eur0 = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export default function MasseSalariale() {
  const { season } = useSeason();
  const data = useQuery(api.paie.getMasseSalariale, { saison: season });
  const userSettings = useQuery(api.users.getCurrentUserSettings);
  const removeSalarie = useMutation(api.paie.removeSalarie);
  const reprendreSaisonPrecedente = useMutation(api.paie.reprendreSaisonPrecedente);

  const isAdmin = userSettings?.role === "admin";
  const [reprise, setReprise] = useState(false);
  const [autoSeason, setAutoSeason] = useState<string | null>(null);

  const handleReprise = async (silent = false) => {
    setReprise(true);
    try {
      const res = await reprendreSaisonPrecedente({ saison: season });
      if (!silent) alert(res.message);
    } catch (err: unknown) {
      console.error(err);
      if (!silent) {
        alert(
          err instanceof Error
            ? err.message
            : "Erreur lors de la reprise de la saison précédente.",
        );
      }
    } finally {
      setReprise(false);
    }
  };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isSalarieModalOpen, setIsSalarieModalOpen] = useState(false);
  const [salarieToEdit, setSalarieToEdit] = useState<SalarieRow | null>(null);
  const [tab, setTab] = useState<"masse" | "planning" | "previsionnel" | "synthese">("masse");

  const params = data?.params;
  const salaries = useMemo(() => data?.salaries ?? [], [data]);
  const prevSalaries = useMemo(() => data?.prevSalaries ?? [], [data]);

  // Saison dynamique : si la saison courante est vide mais que la précédente
  // contient des moniteurs, on la peuple automatiquement (reprise silencieuse).
  useEffect(() => {
    if (
      isAdmin &&
      data !== undefined &&
      salaries.length === 0 &&
      prevSalaries.length > 0 &&
      !reprise &&
      autoSeason !== season
    ) {
      // Déclenchement volontaire d'une seule reprise automatique par saison.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoSeason(season);
      void handleReprise(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, data, salaries.length, prevSalaries.length, season]);

  const toInput = (s: { nom: string; typeContrat: "CDII" | "CDI"; nbHeuresAnnuel: number; nbMois: number; tauxHoraireBrut: number }): SalaireInput => ({
    nom: s.nom, typeContrat: s.typeContrat, nbHeuresAnnuel: s.nbHeuresAnnuel, nbMois: s.nbMois, tauxHoraireBrut: s.tauxHoraireBrut,
  });

  // Calcul de paie par salarié, via la fonction pure partagée.
  const rows = useMemo(() => {
    if (!params) return [];
    const p = toParametresPaie(params);
    return salaries.map((s) => ({ s, base: computePaie(toInput(s), p) }));
  }, [salaries, params]);

  const totaux = params ? computeTotaux(rows.map((r) => r.base), params.margeSecurite) : null;

  // Saison « de référence » : taux renseignés mais heures inconnues (ex: 2023-24,
  // base des augmentations). On masque alors les coûts qui ne seraient pas fiables.
  const seasonHasHours = salaries.some((s) => s.nbHeuresAnnuel > 0);

  // Ventilation du coût employeur entre loisir et compétition, au prorata des
  // heures de chaque moniteur. Alimente les deux lignes auto du prévisionnel.
  const masseSalarialeSplit = useMemo(() => {
    if (!seasonHasHours) return null;
    let loisir = 0;
    let competition = 0;
    for (const { s, base } of rows) {
      const total = s.heuresLoisir + s.heuresCompetition;
      if (total > 0) {
        loisir += base.coutAnnuel * (s.heuresLoisir / total);
        competition += base.coutAnnuel * (s.heuresCompetition / total);
      } else {
        loisir += base.coutAnnuel;
      }
    }
    return { loisir, competition };
  }, [rows, seasonHasHours]);

  // Comparaison avec la saison précédente (effet augmentation + variation d'heures
  // + arrivées/départs). Coût N-1 calculé avec les paramètres de la saison N-1.
  // Ignorée si la saison précédente n'a pas d'heures (comparaison non significative).
  const comparaison = useMemo(() => {
    if (!params || prevSalaries.length === 0) return null;
    if (!prevSalaries.some((s) => s.nbHeuresAnnuel > 0)) return null;
    const pN = toParametresPaie(params);
    const pN1 = data?.prevParams ? toParametresPaie(data.prevParams) : pN;

    const coutN = new Map<string, PaieResult>(
      salaries.map((s) => [s.salarieId, computePaie(toInput(s), pN)])
    );
    const coutN1 = new Map<string, PaieResult>(
      prevSalaries.map((s) => [s.salarieId, computePaie(toInput(s), pN1)])
    );

    const byId = new Map<string, { nom: string; typeContrat: "CDII" | "CDI"; ordre: number }>();
    for (const s of prevSalaries) byId.set(s.salarieId, s);
    for (const s of salaries) byId.set(s.salarieId, s);

    const lignes = [...byId.entries()].map(([id, s]) => {
      const cN = coutN.get(id)?.coutAnnuel ?? null;
      const cN1 = coutN1.get(id)?.coutAnnuel ?? null;
      const statut = cN1 == null ? "arrivee" : cN == null ? "depart" : "present";
      const delta = (cN ?? 0) - (cN1 ?? 0);
      return { id, nom: s.nom, typeContrat: s.typeContrat, ordre: s.ordre, coutN: cN, coutN1: cN1, delta, statut };
    });
    lignes.sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom));

    const totalN = lignes.reduce((acc, l) => acc + (l.coutN ?? 0), 0);
    const totalN1 = lignes.reduce((acc, l) => acc + (l.coutN1 ?? 0), 0);
    return { lignes, totalN, totalN1, totalDelta: totalN - totalN1 };
  }, [salaries, prevSalaries, params, data]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (s: SalarieRow) => {
    if (window.confirm(`Supprimer ${s.nom} ? (toutes saisons confondues)`)) {
      await removeSalarie({ salarieId: s.salarieId });
    }
  };

  const openEdit = (s: SalarieRow) => {
    setSalarieToEdit(s);
    setIsSalarieModalOpen(true);
  };
  const openNew = () => {
    setSalarieToEdit(null);
    setIsSalarieModalOpen(true);
  };

  const augmentationLabel = (s: SalarieRow): string | null => {
    if (s.tauxPrecedent && s.tauxPrecedent > 0) {
      const pct = (s.tauxHoraireBrut / s.tauxPrecedent - 1) * 100;
      return `+${pct.toFixed(1)} %`;
    }
    if (s.augmentationPct != null) return `+${s.augmentationPct} %`;
    return null;
  };

  return (
    <div className="compta-page fade-in">
      <header
        className="page-header"
        style={{ display: "flex", flexWrap: "wrap", gap: "1rem", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "2rem" }}
      >
        <div>
          <h1>Budget prévisionnel</h1>
        </div>
        {tab === "masse" && isAdmin && salaries.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Link to="/budget/parametres" className="btn-secondary" style={{ width: "auto", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              <Settings2 size={16} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} />
              Paramètres
            </Link>
            <button className="btn-primary" style={{ width: "auto" }} onClick={openNew}>
              <Plus size={18} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} />
              Salarié
            </button>
          </div>
        )}
      </header>

      {/* Onglets : masse salariale / planning des cours */}
      <div style={{ display: "flex", gap: "0.5rem", borderBottom: "2px solid #e5e7eb", marginBottom: "1.5rem" }}>
        {([
          { id: "masse", label: "Masse salariale" },
          { id: "planning", label: "Planning des cours" },
          { id: "previsionnel", label: "Prévisionnel" },
          { id: "synthese", label: "Coût par membre" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0.6rem 1rem",
              fontSize: "0.95rem",
              fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? "#2563eb" : "#6b7280",
              borderBottom: tab === t.id ? "2px solid #2563eb" : "2px solid transparent",
              marginBottom: "-2px",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "planning" ? (
        <PlanningCours isAdmin={isAdmin} />
      ) : tab === "previsionnel" ? (
        <Previsionnel
          masseSalarialeLoisir={masseSalarialeSplit?.loisir}
          masseSalarialeCompetition={masseSalarialeSplit?.competition}
        />
      ) : tab === "synthese" ? (
        <SyntheseCouts
          masseSalarialeLoisir={masseSalarialeSplit?.loisir}
          masseSalarialeCompetition={masseSalarialeSplit?.competition}
          etpTotal={seasonHasHours ? rows.reduce((sum, { s }) => sum + s.nbHeuresAnnuel, 0) / 1582 : undefined}
          etpLoisir={rows.some(({ s }) => s.heuresLoisir > 0) ? rows.reduce((sum, { s }) => sum + s.heuresLoisir, 0) / 1582 : undefined}
          etpCompetition={rows.some(({ s }) => s.heuresCompetition > 0) ? rows.reduce((sum, { s }) => sum + s.heuresCompetition, 0) / 1582 : undefined}
          isAdmin={isAdmin}
        />
      ) : data === undefined ? (
        <div className="loading">Chargement des données...</div>
      ) : reprise && salaries.length === 0 ? (
        <div className="loading">Initialisation de la saison {season} depuis la précédente…</div>
      ) : salaries.length === 0 ? (
        <section className="card glass-card">
          <div className="empty-state" style={{ textAlign: "center" }}>
            <p style={{ marginBottom: "1rem" }}>
              Aucune donnée de masse salariale pour la saison <strong>{season}</strong>.
            </p>
            {isAdmin ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "center" }}>
                <p style={{ color: "#6b7280", maxWidth: "560px" }}>
                  Reprenez les moniteurs de la saison précédente (taux, heures, contrats) puis
                  ajustez les augmentations, ou ajoutez un moniteur manuellement.
                </p>
                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
                  <button className="btn-primary" style={{ width: "auto" }} onClick={() => handleReprise()} disabled={reprise}>
                    <Plus size={16} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} />
                    {reprise ? "Reprise..." : "Reprendre la saison précédente"}
                  </button>
                  <button className="btn-secondary" style={{ width: "auto" }} onClick={openNew}>
                    <Plus size={16} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} />
                    Ajouter manuellement
                  </button>
                </div>
              </div>
            ) : (
              <p style={{ color: "#9ca3af", fontStyle: "italic" }}>
                Contactez un administrateur pour initialiser les données.
              </p>
            )}
          </div>
        </section>
      ) : !seasonHasHours ? (
        <>
          <section className="card glass-card" style={{ marginBottom: "1.5rem", borderLeft: "4px solid #f59e0b" }}>
            <p style={{ margin: 0 }}>
              <strong>Saison de référence.</strong> Les heures ne sont pas renseignées pour
              la saison <strong>{season}</strong> : seuls les taux horaires servent de base
              au calcul des augmentations. Le coût employeur n'est donc pas affiché.
            </p>
          </section>
          <section className="card glass-card" style={{ overflowX: "auto" }}>
            <h2 style={{ marginBottom: "1rem" }}>Taux horaires de référence</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "420px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Salarié</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Taux horaire brut</th>
                  {isAdmin && <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {salaries.map((s) => (
                  <tr key={s.ligneId} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "0.6rem 0.5rem" }}>
                      <div><strong>{s.nom}</strong></div>
                      <div style={{ marginTop: "0.2rem" }}><ContratBadge type={s.typeContrat} /></div>
                    </td>
                    <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }} className="font-mono">{eur(s.tauxHoraireBrut)}</td>
                    {isAdmin && (
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>
                        <button className="btn-icon info" onClick={() => openEdit(s)} title="Modifier"><Edit2 size={16} /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <>
          {/* Cartes de synthèse */}
          <div className="tiles-grid" style={{ marginBottom: "2rem" }}>
            <div className="tile-card bg-info" style={{ padding: "1.5rem" }}>
              <div className="tile-content">
                <p style={{ fontSize: "0.8rem", color: "#000", textTransform: "uppercase" }}>Budget annuel (coût employeur)</p>
                <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>{eur0(totaux!.coutAnnuel)}</h3>
              </div>
            </div>
            <div className="tile-card bg-success" style={{ padding: "1.5rem" }}>
              <div className="tile-content">
                <p style={{ fontSize: "0.8rem", color: "#000", textTransform: "uppercase" }}>Nombre de salariés</p>
                <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>{totaux!.nbSalaries}</h3>
              </div>
            </div>
            <div className="tile-card" style={{ padding: "1.5rem", backgroundColor: "#fef3c7" }}>
              <div className="tile-content">
                <p style={{ fontSize: "0.8rem", color: "#000", textTransform: "uppercase" }}>ETP (équivalent temps plein)</p>
                <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>
                  {(rows.reduce((sum, { s }) => sum + s.nbHeuresAnnuel, 0) / 1582).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </h3>
                {rows.some(({ s }) => s.heuresLoisir > 0 || s.heuresCompetition > 0) && (
                  <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "#92400e", display: "flex", gap: "0.75rem" }}>
                    <span>Loisir : {(rows.reduce((sum, { s }) => sum + s.heuresLoisir, 0) / 1582).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    <span>·</span>
                    <span>Compét. : {(rows.reduce((sum, { s }) => sum + s.heuresCompetition, 0) / 1582).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Tableau par salarié */}
          <section className="card glass-card" style={{ overflowX: "auto" }}>
            <h2 style={{ marginBottom: "1rem" }}>Détail par salarié</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "760px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "0.6rem 0.5rem" }}></th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Salarié</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Heures/an</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Taux brut</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Net/mois</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Coût annuel</th>
                  {isAdmin && <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, base }) => {
                  const id = s.ligneId;
                  const isOpen = expanded.has(id);
                  const aug = augmentationLabel(s);
                  return (
                    <Fragment key={id}>
                      <tr style={{ borderBottom: "1px solid #f0f0f0" }}>
                        <td style={{ padding: "0.6rem 0.5rem" }}>
                          <button
                            onClick={() => toggleExpanded(id)}
                            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}
                            title="Détail"
                          >
                            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                          </button>
                        </td>
                        <td style={{ padding: "0.6rem 0.5rem" }}>
                          <div><strong>{s.nom}</strong></div>
                          <div style={{ marginTop: "0.2rem" }}><ContratBadge type={s.typeContrat} /></div>
                        </td>
                        <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>
                          <div className="font-mono">
                            {s.nbHeuresAnnuel.toLocaleString("fr-FR")}
                            {s.typeContrat === "CDI" && (
                              <span style={{ color: "#9ca3af", fontSize: "0.8rem" }} title="Heures réelles (151,67 × 12 × h / 1582)">
                                {" "}→ {base.heuresAnnuelEffectif.toLocaleString("fr-FR")} réelles
                              </span>
                            )}
                            <span style={{ color: "#9ca3af", fontSize: "0.8rem" }}> ({base.heuresMensuel.toLocaleString("fr-FR")}/mois)</span>
                          </div>
                          {s.heuresAuto && (
                            <div style={{ color: "#9ca3af", fontSize: "0.75rem", marginTop: "0.1rem" }}>
                              Loisir {s.heuresLoisir.toLocaleString("fr-FR")} · Compét. {s.heuresCompetition.toLocaleString("fr-FR")}
                            </div>
                          )}
                          {s.heuresSup?.map((hs, i) => (
                            <div key={i} style={{ color: "#9ca3af", fontSize: "0.72rem" }}>
                              + {hs.nbHeures} h — {hs.designation}{hs.competition ? " (compét.)" : ""}
                            </div>
                          ))}
                        </td>
                        <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }} className="font-mono">
                          {eur(s.tauxHoraireBrut)}
                          {aug && (
                            <span className="badge" style={{ marginLeft: "0.4rem", fontSize: "0.7rem", backgroundColor: "#dcfce7", color: "#166534" }}>
                              {aug}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }} className="font-mono">
                          {eur(base.netMensuel)}
                        </td>
                        <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: "bold" }} className="font-mono">
                          {eur0(base.coutAnnuel)}
                        </td>
                        {isAdmin && (
                          <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>
                            <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                              <button className="btn-icon info" onClick={() => openEdit(s)} title="Modifier"><Edit2 size={16} /></button>
                              <button className="btn-icon danger" onClick={() => handleDelete(s)} title="Supprimer"><Trash2 size={16} /></button>
                            </div>
                          </td>
                        )}
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={isAdmin ? 7 : 6} style={{ padding: "0 0.5rem 1rem 2.5rem", background: "#fafafa" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.5rem", paddingTop: "0.75rem" }}>
                              <div>
                                <h4 style={{ fontSize: "0.85rem", textTransform: "uppercase", color: "#6b7280", marginBottom: "0.4rem" }}>Construction du brut</h4>
                                <DetailLine label="Salaire" value={eur(base.salaire)} />
                                {s.typeContrat !== "CDI" && <DetailLine label="Indemnité CP" value={eur(base.indemniteCp)} />}
                                <DetailLine label="Salaire brut" value={eur(base.brut)} bold />
                              </div>
                              <div>
                                <h4 style={{ fontSize: "0.85rem", textTransform: "uppercase", color: "#6b7280", marginBottom: "0.4rem" }}>Salarié → Net</h4>
                                <DetailLine label="Cotisations salariales" value={`- ${eur(base.cotisSalariales)}`} />
                                <DetailLine label="Mutuelle salarié" value={`- ${eur(params!.mutuelleSalarie)}`} />
                                <DetailLine label="Net mensuel estimé" value={eur(base.netMensuel)} bold />
                                <DetailLine label="Net annuel" value={eur(base.netAnnuel)} />
                              </div>
                              <div>
                                <h4 style={{ fontSize: "0.85rem", textTransform: "uppercase", color: "#6b7280", marginBottom: "0.4rem" }}>Employeur → Coût</h4>
                                <DetailLine label="Cotisations patronales" value={`+ ${eur(base.cotisPatronales)}`} />
                                <DetailLine label="Mutuelle employeur" value={`+ ${eur(params!.mutuelleEmployeur)}`} />
                                <DetailLine label="Prime équip. (/mois)" value={`+ ${eur(params!.primeEquipementAnnuelle / 12)}`} />
                                <DetailLine label="Frais bulletin" value={`+ ${eur(params!.fraisBulletin)}`} />
                                <DetailLine label="Coût mensuel" value={eur(base.coutMensuel)} bold />
                                <DetailLine label={`Coût annuel (×${s.nbMois} mois)`} value={eur(base.coutAnnuel)} bold />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid #e5e7eb", fontWeight: "bold" }}>
                  <td colSpan={5} style={{ padding: "0.75rem 0.5rem", textAlign: "right" }}>Total coût annuel</td>
                  <td style={{ padding: "0.75rem 0.5rem", textAlign: "right" }} className="font-mono">{eur0(totaux!.coutAnnuel)}</td>
                  {isAdmin && <td></td>}
                </tr>
              </tfoot>
            </table>
          </section>

          {/* Évolution vs saison précédente */}
          {comparaison && (
            <section className="card glass-card" style={{ marginTop: "2rem", overflowX: "auto" }}>
              <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <TrendingUp size={20} /> Évolution vs saison {data!.prevSaison}
              </h2>
              <p style={{ color: "#6b7280", marginBottom: "1rem", fontSize: "0.9rem" }}>
                Effet combiné des augmentations de taux, des variations d'heures et des
                arrivées / départs de moniteurs.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "640px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                    <th style={{ padding: "0.6rem 0.5rem" }}>Salarié</th>
                    <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Coût {data!.prevSaison}</th>
                    <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Coût {season}</th>
                    <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>Variation</th>
                  </tr>
                </thead>
                <tbody>
                  {comparaison.lignes.map((l) => (
                    <tr key={l.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                      <td style={{ padding: "0.6rem 0.5rem" }}>
                        <div><strong>{l.nom}</strong></div>
                        <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.2rem", flexWrap: "wrap" }}>
                          <ContratBadge type={l.typeContrat} />
                          {l.statut === "arrivee" && (
                            <span className="badge" style={{ fontSize: "0.7rem", backgroundColor: "#dcfce7", color: "#166534", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
                              <ArrowUpRight size={11} /> Arrivée
                            </span>
                          )}
                          {l.statut === "depart" && (
                            <span className="badge" style={{ fontSize: "0.7rem", backgroundColor: "#fee2e2", color: "#991b1b", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
                              <ArrowDownRight size={11} /> Départ
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }} className="font-mono">
                        {l.coutN1 == null ? "—" : eur0(l.coutN1)}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right" }} className="font-mono">
                        {l.coutN == null ? "—" : eur0(l.coutN)}
                      </td>
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "right", fontWeight: "bold" }} className="font-mono">
                        <span style={{ color: l.delta >= 0 ? "#b91c1c" : "#15803d" }}>
                          {l.delta >= 0 ? "+ " : "- "}{eur0(Math.abs(l.delta))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid #e5e7eb", fontWeight: "bold" }}>
                    <td style={{ padding: "0.75rem 0.5rem" }}>Total</td>
                    <td style={{ padding: "0.75rem 0.5rem", textAlign: "right" }} className="font-mono">{eur0(comparaison.totalN1)}</td>
                    <td style={{ padding: "0.75rem 0.5rem", textAlign: "right" }} className="font-mono">{eur0(comparaison.totalN)}</td>
                    <td style={{ padding: "0.75rem 0.5rem", textAlign: "right" }} className="font-mono">
                      <span style={{ color: comparaison.totalDelta >= 0 ? "#b91c1c" : "#15803d" }}>
                        {comparaison.totalDelta >= 0 ? "+ " : "- "}{eur0(Math.abs(comparaison.totalDelta))}
                        <span style={{ color: "#6b7280", fontWeight: "normal", marginLeft: "0.4rem" }}>
                          ({comparaison.totalN1 > 0 ? ((comparaison.totalDelta / comparaison.totalN1) * 100).toFixed(1) : "0"} %)
                        </span>
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}
        </>
      )}

      <SalarieFormModal
        isOpen={isSalarieModalOpen}
        onClose={() => setIsSalarieModalOpen(false)}
        salarieToEdit={salarieToEdit}
      />
    </div>
  );
}

function ContratBadge({ type }: { type: "CDI" | "CDII" }) {
  const style =
    type === "CDI"
      ? { backgroundColor: "#dcfce7", color: "#166534" }
      : { backgroundColor: "#fef3c7", color: "#92400e" };
  return (
    <span className="badge" style={{ fontSize: "0.7rem", ...style }}>
      {type}
    </span>
  );
}

function DetailLine({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.15rem 0", fontWeight: bold ? "bold" : "normal" }}>
      <span style={{ color: "#374151" }}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
