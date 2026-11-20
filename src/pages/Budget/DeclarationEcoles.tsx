import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useSeason } from "../../contexts/SeasonContext";

const eur0 = (n: number) =>
  Math.round(n).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

function CopyButton({
  value,
  label,
  copiedKey,
  itemKey,
  onCopy,
}: {
  value: string;
  label: string;
  copiedKey: string | null;
  itemKey: string;
  onCopy: (key: string, text: string) => void;
}) {
  const isCopied = copiedKey === itemKey;
  return (
    <button
      type="button"
      onClick={() => onCopy(itemKey, value)}
      title={`Copier ${label} (${value})`}
      aria-label={`Copier ${label} : ${value}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.2rem",
        marginLeft: "0.35rem",
        border: "1px solid var(--border-color)",
        background: isCopied ? "#dcfce7" : "#fff",
        color: isCopied ? "#166534" : "var(--foreground)",
        cursor: "pointer",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    >
      {isCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export default function DeclarationEcoles() {
  const { season } = useSeason();
  const data = useQuery(api.budgetRecettes.getDeclarationEcoles, { saison: season });
  const [includeAdultes, setIncludeAdultes] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    }).catch(() => {});
  };

  const visibleCategories = useMemo(() => {
    if (!data) return [];
    return includeAdultes
      ? data.categories
      : data.categories.filter((c) => !c.estAdulte);
  }, [data, includeAdultes]);

  const hasAdultes = useMemo(
    () => (data?.categories ?? []).some((c) => c.estAdulte),
    [data],
  );

  const totaux = useMemo(() => {
    let nbJeunes = 0;
    let totalJeunesSeances = 0;
    let recette = 0;
    let coutSalarial: number | null = 0;

    for (const cat of visibleCategories) {
      nbJeunes += cat.nbJeunes;
      totalJeunesSeances += cat.totalJeunesSeances;
      recette += cat.recette;
      if (cat.coutSalarial === null) {
        coutSalarial = null;
      } else if (coutSalarial !== null) {
        coutSalarial += cat.coutSalarial;
      }
    }

    const resultat = coutSalarial === null ? null : recette - coutSalarial;
    return { nbJeunes, totalJeunesSeances, recette, coutSalarial, resultat };
  }, [visibleCategories]);

  const handleCopyTsv = () => {
    const header = [
      "Catégorie",
      "Enca. Prof.",
      "Nb Cours / sem",
      "Nb Jeunes",
      "Total",
      "Frais Prof.",
      "Part Globale Stagiaires",
      "Solde",
    ].join("\t");
    const rows = visibleCategories.map((c) =>
      [
        c.nom,
        c.nbEncadrants,
        c.nbCoursParSemaine,
        c.nbJeunes,
        c.totalJeunesSeances,
        c.coutSalarial === null ? "" : Math.round(c.coutSalarial),
        Math.round(c.recette),
        c.resultat === null ? "" : Math.round(c.resultat),
      ].join("\t"),
    );
    const totalRow = [
      "Totaux",
      "",
      "",
      totaux.nbJeunes,
      totaux.totalJeunesSeances,
      totaux.coutSalarial === null ? "" : Math.round(totaux.coutSalarial),
      Math.round(totaux.recette),
      totaux.resultat === null ? "" : Math.round(totaux.resultat),
    ].join("\t");
    handleCopy("tsv", [header, ...rows, totalRow].join("\n"));
  };

  if (data === undefined) {
    return <div className="loading">Chargement de la déclaration des écoles…</div>;
  }

  const paieIncomplete = !data.hasParametresPaie || data.moniteursSansPaie.length > 0;

  return (
    <div className="fade-in" style={{ display: "grid", gap: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <p style={{ margin: 0, color: "#4b5563", fontSize: "0.9rem" }}>
          Valeurs calculées à capacité pleine en cohérence avec le prévisionnel et la masse salariale de{" "}
          <strong>{season}</strong> (hors SNE). Cliquez sur l’icône copier pour récupérer le montant brut.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
          {hasAdultes && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                fontSize: "0.85rem",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={includeAdultes}
                onChange={(e) => setIncludeAdultes(e.target.checked)}
              />
              Inclure les cours adultes (ESC02)
            </label>
          )}
          {visibleCategories.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              style={{ width: "auto", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              onClick={handleCopyTsv}
            >
              {copiedKey === "tsv" ? <Check size={16} /> : <Copy size={16} />}
              {copiedKey === "tsv" ? "Tableau copié" : "Copier le tableau (TSV)"}
            </button>
          )}
        </div>
      </div>

      {paieIncomplete && (
        <div className="budget-alert budget-alert--warning" role="status">
          <TriangleAlert size={22} aria-hidden="true" />
          <span>
            {!data.hasParametresPaie
              ? `Les paramètres de paie ne sont pas configurés pour ${season}.`
              : `Masse salariale incomplète pour : ${data.moniteursSansPaie.join(", ")}.`}{" "}
            Les rentrées restent affichées, mais les frais prof. concernés ne peuvent pas être calculés.
          </span>
        </div>
      )}

      {visibleCategories.length === 0 ? (
        <section className="card glass-card empty-state">
          <h2>Aucune catégorie de cours</h2>
          <p>
            {hasAdultes && !includeAdultes
              ? `Seuls des cours adultes (ESC02) sont planifiés pour ${season}. Cochez « Inclure les cours adultes (ESC02) » pour les afficher.`
              : "Ajoutez des créneaux dans l’onglet « Planning des cours » pour générer les données de déclaration."}
          </p>
        </section>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: "1rem",
            }}
          >
            <div className="card glass-card" style={{ margin: 0 }}>
              <p style={{ fontSize: "0.78rem", textTransform: "uppercase", margin: "0 0 0.35rem", color: "#4b5563" }}>
                Rentrées (Part stagiaires)
              </p>
              <p className="font-mono" style={{ fontSize: "1.45rem", fontWeight: 800, margin: 0, color: "#15803d" }}>
                {eur0(totaux.recette)}
                <CopyButton
                  value={String(Math.round(totaux.recette))}
                  label="total rentrées"
                  copiedKey={copiedKey}
                  itemKey="kpi-recette"
                  onCopy={handleCopy}
                />
              </p>
            </div>

            <div className="card glass-card" style={{ margin: 0 }}>
              <p style={{ fontSize: "0.78rem", textTransform: "uppercase", margin: "0 0 0.35rem", color: "#4b5563" }}>
                Sorties (Frais Prof.)
              </p>
              <p className="font-mono" style={{ fontSize: "1.45rem", fontWeight: 800, margin: 0, color: "#b91c1c" }}>
                {totaux.coutSalarial === null ? (
                  "Non disponible"
                ) : (
                  <>
                    {eur0(totaux.coutSalarial)}
                    <CopyButton
                      value={String(Math.round(totaux.coutSalarial))}
                      label="total frais prof"
                      copiedKey={copiedKey}
                      itemKey="kpi-cout"
                      onCopy={handleCopy}
                    />
                  </>
                )}
              </p>
            </div>

            <div className="card glass-card" style={{ margin: 0 }}>
              <p style={{ fontSize: "0.78rem", textTransform: "uppercase", margin: "0 0 0.35rem", color: "#4b5563" }}>
                Solde (Rentrées − Sorties)
              </p>
              <p
                className="font-mono"
                style={{
                  fontSize: "1.45rem",
                  fontWeight: 800,
                  margin: 0,
                  color:
                    totaux.resultat === null
                      ? "#4b5563"
                      : totaux.resultat >= 0
                        ? "#15803d"
                        : "#b91c1c",
                }}
              >
                {totaux.resultat === null ? "—" : eur0(totaux.resultat)}
              </p>
            </div>
          </div>

          <section className="card glass-card" style={{ margin: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "820px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border-color)", textAlign: "left" }}>
                  <th style={{ padding: "0.65rem 0.5rem" }}>Catégorie de cours</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Enca. Prof.</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Cours / sem.</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Nb Jeunes</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Total</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Frais Prof.</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Part Stagiaires</th>
                  <th style={{ padding: "0.65rem 0.5rem", textAlign: "right" }}>Solde</th>
                </tr>
              </thead>
              <tbody>
                {visibleCategories.map((cat) => {
                  const coutArrondi = cat.coutSalarial === null ? null : Math.round(cat.coutSalarial);
                  const recetteArrondie = Math.round(cat.recette);
                  const soldeArrondi = cat.resultat === null ? null : Math.round(cat.resultat);
                  return (
                    <tr key={cat.nom} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      <td style={{ padding: "0.65rem 0.5rem" }}>
                        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.4rem" }}>
                          <strong>{cat.nom}</strong>
                          <CopyButton
                            value={cat.nom}
                            label="nom de catégorie"
                            copiedKey={copiedKey}
                            itemKey={`nom-${cat.nom}`}
                            onCopy={handleCopy}
                          />
                          {cat.competition && (
                            <span
                              className="badge"
                              style={{
                                fontSize: "0.68rem",
                                padding: "0.15rem 0.45rem",
                                backgroundColor: "#fef3c7",
                                color: "#92400e",
                              }}
                            >
                              Compétition
                            </span>
                          )}
                          {cat.analytiqueNom && (
                            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                              {cat.analytiqueNom}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.2rem" }}>
                          {cat.nbCreneaux} créneau{cat.nbCreneaux > 1 ? "x" : ""} · {eur0(cat.tarifAnnuel)}/an
                          {cat.moniteursNoms.length > 0 ? ` · ${cat.moniteursNoms.join(", ")}` : ""}
                        </div>
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cat.nbEncadrants}
                        <CopyButton
                          value={String(cat.nbEncadrants)}
                          label="encadrants"
                          copiedKey={copiedKey}
                          itemKey={`enca-${cat.nom}`}
                          onCopy={handleCopy}
                        />
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cat.nbCoursParSemaine}
                        <CopyButton
                          value={String(cat.nbCoursParSemaine)}
                          label="cours par semaine"
                          copiedKey={copiedKey}
                          itemKey={`sem-${cat.nom}`}
                          onCopy={handleCopy}
                        />
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cat.nbJeunes}
                        <CopyButton
                          value={String(cat.nbJeunes)}
                          label="nombre de jeunes"
                          copiedKey={copiedKey}
                          itemKey={`jeunes-${cat.nom}`}
                          onCopy={handleCopy}
                        />
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cat.totalJeunesSeances}
                        <CopyButton
                          value={String(cat.totalJeunesSeances)}
                          label="total"
                          copiedKey={copiedKey}
                          itemKey={`total-${cat.nom}`}
                          onCopy={handleCopy}
                        />
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {coutArrondi === null ? (
                          <span style={{ color: "#9ca3af" }}>—</span>
                        ) : (
                          <>
                            {eur0(coutArrondi)}
                            <CopyButton
                              value={String(coutArrondi)}
                              label="frais prof"
                              copiedKey={copiedKey}
                              itemKey={`cout-${cat.nom}`}
                              onCopy={handleCopy}
                            />
                          </>
                        )}
                      </td>

                      <td className="font-mono" style={{ padding: "0.65rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                        {eur0(recetteArrondie)}
                        <CopyButton
                          value={String(recetteArrondie)}
                          label="part stagiaires"
                          copiedKey={copiedKey}
                          itemKey={`recette-${cat.nom}`}
                          onCopy={handleCopy}
                        />
                      </td>

                      <td
                        className="font-mono"
                        style={{
                          padding: "0.65rem 0.5rem",
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          fontWeight: 700,
                          color:
                            soldeArrondi === null
                              ? "#9ca3af"
                              : soldeArrondi >= 0
                                ? "#15803d"
                                : "#b91c1c",
                        }}
                      >
                        {soldeArrondi === null ? "—" : eur0(soldeArrondi)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--border-color)", fontWeight: 800, background: "#f9fafb" }}>
                  <td style={{ padding: "0.75rem 0.5rem" }}>Totaux déclaration</td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right" }}>—</td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right" }}>—</td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    {totaux.nbJeunes}
                    <CopyButton
                      value={String(totaux.nbJeunes)}
                      label="total jeunes"
                      copiedKey={copiedKey}
                      itemKey="tot-jeunes"
                      onCopy={handleCopy}
                    />
                  </td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    {totaux.totalJeunesSeances}
                    <CopyButton
                      value={String(totaux.totalJeunesSeances)}
                      label="total séances-jeunes"
                      copiedKey={copiedKey}
                      itemKey="tot-seances"
                      onCopy={handleCopy}
                    />
                  </td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    {totaux.coutSalarial === null ? (
                      "—"
                    ) : (
                      <>
                        {eur0(totaux.coutSalarial)}
                        <CopyButton
                          value={String(Math.round(totaux.coutSalarial))}
                          label="total frais prof"
                          copiedKey={copiedKey}
                          itemKey="tot-cout"
                          onCopy={handleCopy}
                        />
                      </>
                    )}
                  </td>
                  <td className="font-mono" style={{ padding: "0.75rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    {eur0(totaux.recette)}
                    <CopyButton
                      value={String(Math.round(totaux.recette))}
                      label="total part stagiaires"
                      copiedKey={copiedKey}
                      itemKey="tot-recette"
                      onCopy={handleCopy}
                    />
                  </td>
                  <td
                    className="font-mono"
                    style={{
                      padding: "0.75rem 0.5rem",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      color:
                        totaux.resultat === null
                          ? "#4b5563"
                          : totaux.resultat >= 0
                            ? "#15803d"
                            : "#b91c1c",
                    }}
                  >
                    {totaux.resultat === null ? "—" : eur0(totaux.resultat)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
