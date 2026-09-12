/* eslint-disable @typescript-eslint/no-explicit-any --
   Les dossiers / transactions / groupes exposés par api.paiements.getDossiers
   proviennent de payloads HelloAsso non typés : on les manipule en `any` de
   façon délibérée et bornée dans cette page (comme dans convex/helloasso.ts). */
import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { PaiementsDossiersContextValue } from "./Layout";

const STATUS_OPTIONS = [
  { value: "Traité", cls: "on-traite" },
  { value: "En attente", cls: "on-attente" },
  { value: "Remboursé", cls: "on-rembourse" },
  { value: "Problème", cls: "on-probleme" },
] as const;

const NEEDS_COMMENT = new Set(["En attente", "Remboursé", "Problème"]);

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} à ${time}`;
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function normalise(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ─── Barre de stats ───────────────────────────────────────────────────────────

function StatsBar({ dossiers }: { dossiers: any[] }) {
  const counts = useMemo(() => {
    const t: Record<string, number> = { total: dossiers.length };
    for (const d of dossiers) {
      const k = d.local_status ?? "À traiter";
      t[k] = (t[k] ?? 0) + 1;
    }
    return t;
  }, [dossiers]);

  const items = [
    { label: "Total", value: counts["total"] ?? 0, color: "#000" },
    { label: "À traiter", value: counts["À traiter"] ?? 0, color: "#888" },
    { label: "En attente", value: counts["En attente"] ?? 0, color: "#b59f00" },
    { label: "Traité", value: counts["Traité"] ?? 0, color: "#2e7d32" },
    { label: "Problème", value: counts["Problème"] ?? 0, color: "#c62828" },
    { label: "Remboursé", value: counts["Remboursé"] ?? 0, color: "#4f87a0" },
  ];

  return (
    <div className="pay-stats">
      {items.map((it) => (
        <div className="pay-stat" key={it.label}>
          <span className="val" style={{ color: it.color }}>
            {it.value}
          </span>
          <span className="lbl">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Stats par responsable (superuser) ─────────────────────────────────────────

function StatsByResponsible({
  dossiers,
  responsibles,
}: {
  dossiers: any[];
  responsibles: { id: string; name: string }[];
}) {
  const rows = useMemo(() => {
    const empty = () => ({
      total: 0,
      "À traiter": 0,
      "En attente": 0,
      Traité: 0,
      Problème: 0,
      Remboursé: 0,
    });
    const map = new Map<string | null, ReturnType<typeof empty>>();
    for (const r of responsibles) map.set(r.id, empty());
    map.set(null, empty());

    for (const d of dossiers) {
      const respId = d.responsible_id || null;
      let row = map.get(respId);
      if (!row) {
        row = empty();
        map.set(respId, row);
      }
      row.total++;
      const k = (d.local_status ?? "À traiter") as keyof ReturnType<typeof empty>;
      (row[k] as number) = (row[k] ?? 0) + 1;
    }

    const out = responsibles
      .map((r) => ({ name: r.name, stats: map.get(r.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const none = map.get(null);
    if (none && none.total > 0) out.push({ name: "Sans responsable", stats: none });
    return out;
  }, [dossiers, responsibles]);

  return (
    <div className="pay-stats-table">
      <h3>Statistiques par responsable</h3>
      <table>
        <thead>
          <tr>
            <th>Responsable</th>
            <th>Total</th>
            <th>À traiter</th>
            <th>En attente</th>
            <th>Traité</th>
            <th>Problème</th>
            <th>Remboursé</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ fontWeight: 700 }}>{row.name}</td>
              <td style={{ fontWeight: 700 }}>{row.stats.total}</td>
              <td>{row.stats["À traiter"]}</td>
              <td style={{ color: "#b59f00", fontWeight: 700 }}>
                {row.stats["En attente"]}
              </td>
              <td style={{ color: "#2e7d32", fontWeight: 700 }}>
                {row.stats["Traité"]}
              </td>
              <td style={{ color: "#c62828", fontWeight: 700 }}>
                {row.stats["Problème"]}
              </td>
              <td style={{ color: "#4f87a0", fontWeight: 700 }}>
                {row.stats["Remboursé"]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Carte dossier ─────────────────────────────────────────────────────────────

function DossierCard({
  dossier,
  responsibles,
  approvedStudents,
  waitingStudents,
  onSave,
  onReset,
}: {
  dossier: any;
  responsibles: { id: string; name: string }[];
  approvedStudents: any[];
  waitingStudents: any[];
  onSave: (status: string, comment: string | undefined) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleHelloassoClick = () => {
    const slug = (() => {
      try {
        return new URL(dossier.link_url).pathname.split("/")[2];
      } catch {
        return null;
      }
    })();
    const adminUrl = slug
      ? `https://admin.helloasso.com/${slug}/suivi-paiements`
      : dossier.link_url;
    window.open(adminUrl, "_blank", "noopener,noreferrer");
    navigator.clipboard
      .writeText(dossier.payer_email)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const handleStatusClick = async (status: string) => {
    setErr(null);
    if (dossier.local_status === status) {
      setSaving(true);
      try {
        await onReset();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
      return;
    }
    if (NEEDS_COMMENT.has(status)) {
      setComment(dossier.comment ?? "");
      setPendingStatus(status);
      return;
    }
    setSaving(true);
    try {
      await onSave(status, undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    if (!pendingStatus) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave(pendingStatus, comment.trim() || undefined);
      setPendingStatus(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const resp = responsibles.find((r) => r.id === dossier.updated_by);
  const approvalGroups = useMemo(
    () => dossier.groups.filter((g: any) => g.requires_approval),
    [dossier.groups]
  );
  const hasApprovalGroup = approvalGroups.length > 0;

  const isApproved = useMemo(() => {
    if (!hasApprovalGroup) return false;
    return approvalGroups.every((g: any) =>
      approvedStudents.some((s) => {
        if (s.group_id !== g.id) return false;
        if (s.email) {
          const se = s.email.toLowerCase();
          if (
            se === dossier.payer_email.toLowerCase() ||
            (dossier.email && se === dossier.email.toLowerCase())
          )
            return true;
        }
        return (
          normalise(s.first_name).trim() === normalise(dossier.first_name).trim() &&
          normalise(s.last_name).trim() === normalise(dossier.last_name).trim()
        );
      })
    );
  }, [approvalGroups, hasApprovalGroup, approvedStudents, dossier]);

  const matchingApproved = useMemo(() => {
    if (!hasApprovalGroup) return [];
    return approvedStudents.filter((s) => {
      if (!approvalGroups.some((g: any) => g.id === s.group_id)) return false;
      if (s.email) {
        const se = s.email.toLowerCase();
        if (
          se === dossier.payer_email.toLowerCase() ||
          (dossier.email && se === dossier.email.toLowerCase())
        )
          return true;
      }
      return (
        normalise(s.first_name).trim() === normalise(dossier.first_name).trim() &&
        normalise(s.last_name).trim() === normalise(dossier.last_name).trim()
      );
    });
  }, [approvalGroups, hasApprovalGroup, approvedStudents, dossier]);

  const matchingWaiting = useMemo(() => {
    const emails = new Set([
      dossier.payer_email.toLowerCase(),
      ...(dossier.email ? [dossier.email.toLowerCase()] : []),
    ]);
    return waitingStudents.filter((s) => emails.has(s.email.toLowerCase()));
  }, [waitingStudents, dossier]);

  const positiveTx = dossier.transactions.filter(
    (t: any) => !t.helloasso_payment_id.startsWith("refund-")
  );

  return (
    <div className="pay-dossier" style={{ opacity: saving ? 0.6 : 1 }}>
      <div className="pay-dossier-top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pay-dossier-line">
            <span className="pay-dossier-key">Inscrit:</span>
            <span className="pay-dossier-name">
              {dossier.first_name} {dossier.last_name}
            </span>
            {hasApprovalGroup && (
              <span title="Groupe sous approbation">
                🔒{" "}
                {isApproved ? (
                  <span style={{ color: "#2e7d32", fontWeight: 700 }}>✓</span>
                ) : (
                  <span style={{ color: "#c62828", fontWeight: 700 }}>✗</span>
                )}
              </span>
            )}
          </div>
          {matchingApproved.length > 0 && (
            <div className="pay-dossier-line">
              <span className="pay-dossier-key">Approuvé:</span>
              <span style={{ color: "#2e7d32", fontWeight: 700, fontSize: "0.8rem" }}>
                {matchingApproved
                  .map((s) => `${s.first_name} ${s.last_name}`)
                  .join(", ")}
              </span>
            </div>
          )}
          <div className="pay-dossier-line">
            <span className="pay-dossier-key">Payeur:</span>
            <span style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "#777" }}>
              {dossier.payer_first_name} {dossier.payer_last_name}
            </span>
          </div>
          {dossier.payer_email && (
            <p
              style={{
                fontFamily: "monospace",
                fontSize: "0.72rem",
                color: "#aaa",
                paddingLeft: "4.9rem",
              }}
            >
              {dossier.payer_email}
            </p>
          )}
          {matchingWaiting.length > 0 && (
            <div className="pay-dossier-line" style={{ marginTop: "0.2rem" }}>
              <span className="pay-dossier-key">Attente:</span>
              <span className="pay-badge pay-badge-waiting" title="Sur liste d'attente">
                ⏳{" "}
                {matchingWaiting
                  .map((s) => `${s.first_name} ${s.last_name}`)
                  .join(", ")}
              </span>
            </div>
          )}
        </div>

        <div className="pay-dossier-meta">
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span
              className={`pay-badge ${dossier.is_installment ? "pay-badge-3x" : "pay-badge-1x"}`}
            >
              {dossier.is_installment ? "3×" : "1×"}
            </span>
            <span className="pay-amount">{formatAmount(dossier.total_amount)}</span>
          </div>
          <span className="pay-date">{formatDateTime(dossier.first_payment_date)}</span>
          {resp && dossier.updated_at && (
            <span className="pay-date" style={{ fontSize: "0.7rem", color: "#bbb" }}>
              {resp.name} · {formatDateTime(dossier.updated_at)}
            </span>
          )}
        </div>
      </div>

      {!pendingStatus && (
        <div className="pay-status-btns">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`pay-status-btn${dossier.local_status === opt.value ? ` ${opt.cls}` : ""}`}
              onClick={() => handleStatusClick(opt.value)}
              disabled={saving}
            >
              {opt.value}
              {dossier.local_status === opt.value && " ×"}
            </button>
          ))}
          <button
            className="pay-btn pay-btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={handleHelloassoClick}
            title={`Ouvrir HelloAsso admin + copier l'email payeur (${dossier.payer_email})`}
          >
            {copied ? "✓ Email copié" : "↗ HelloAsso"}
          </button>
        </div>
      )}

      {pendingStatus && (
        <div className="pay-confirm">
          <p
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#777",
            }}
          >
            {pendingStatus} — commentaire (optionnel)
          </p>
          <textarea
            className="pay-textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Ex : chèque non reçu, remboursement demandé le…"
            rows={2}
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="pay-btn pay-btn-sm pay-btn-dark"
              onClick={handleConfirm}
              disabled={saving}
            >
              {saving ? "Enregistrement…" : `Confirmer ${pendingStatus}`}
            </button>
            <button
              className="pay-btn pay-btn-sm"
              onClick={() => {
                setPendingStatus(null);
                setComment("");
                setErr(null);
              }}
              disabled={saving}
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {!pendingStatus && dossier.comment && (
        <p className="pay-comment">{dossier.comment}</p>
      )}

      {err && (
        <p style={{ marginTop: "0.4rem", fontSize: "0.75rem", color: "#c62828" }}>
          {err}
        </p>
      )}

      {dossier.has_status_mismatch && !dossier.needs_refund_action && (
        <p style={{ marginTop: "0.4rem", fontSize: "0.72rem", fontWeight: 700, color: "#c62828" }}>
          ⚠ HelloAsso indique un remboursement
        </p>
      )}

      {dossier.needs_refund_action && (
        <p className="pay-warn">
          {dossier.local_status === "Remboursé"
            ? "⚠ Remboursement demandé localement. À effectuer sur HelloAsso."
            : "⚠ Remboursé sur HelloAsso. Mettre à jour le statut local."}
        </p>
      )}

      {dossier.transactions.length > 0 && (
        <div className="pay-tx">
          {dossier.transactions.map((inst: any) => {
            const isRefund = inst.helloasso_payment_id.startsWith("refund-");
            const posIndex = positiveTx.findIndex(
              (t: any) => t.helloasso_payment_id === inst.helloasso_payment_id
            );
            const label = isRefund
              ? "Remboursement"
              : dossier.is_installment
                ? `Échéance ${posIndex + 1}/${positiveTx.length}`
                : "Paiement";
            const isSuccess =
              inst.helloasso_status === "Authorized" ||
              inst.helloasso_status === "Processed";
            const isRefunded = inst.helloasso_status === "Refunded";

            return (
              <div className="pay-tx-row" key={inst.helloasso_payment_id}>
                <span className={`lbl${isRefund ? " pay-tx-refund" : ""}`}>
                  {label}
                </span>
                <span className={isRefund ? "pay-tx-refund" : ""}>
                  {formatAmount(Number(inst.amount))}
                </span>
                <span>{formatDateTime(inst.payment_date)}</span>
                <span
                  className={isSuccess ? "pay-tx-ok" : isRefunded ? "pay-tx-refund" : ""}
                >
                  → {isSuccess ? "Validé" : isRefunded ? "Remboursé" : inst.helloasso_status}
                </span>
                {(inst.payment_receipt_url || inst.fiscal_receipt_url) && (
                  <span style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
                    {inst.payment_receipt_url && (
                      <a
                        className="pay-receipt"
                        href={inst.payment_receipt_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Attestation de paiement"
                      >
                        📄 Attestation
                      </a>
                    )}
                    {inst.fiscal_receipt_url && (
                      <a
                        className="pay-receipt"
                        href={inst.fiscal_receipt_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Reçu fiscal"
                      >
                        💼 Reçu fiscal
                      </a>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function ValidationPaiements() {
  const currentUser = useQuery(api.users.current);
  const settings = useQuery(api.users.getCurrentUserSettings);
  const { dossiers, syncing, synchroniserMaintenant } =
    useOutletContext<PaiementsDossiersContextValue>();
  const responsibles = useQuery(api.paiements.getResponsibles);
  const approvedStudents = useQuery(api.paiements.getApprovedStudents);
  const waitingStudents = useQuery(api.paiements.getWaitingStudents);

  const setDossierStatus = useMutation(api.paiements.setDossierStatus);
  const resetDossierStatus = useMutation(api.paiements.resetDossierStatus);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ synced_count: number; errors: string[] } | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("À traiter");
  const [filterType, setFilterType] = useState("");
  // null = pas encore choisi → le filtre par défaut est DÉRIVÉ sur l'utilisateur
  // courant (aucun setState dans un effet). Une sélection explicite (ou Reset)
  // fixe la valeur.
  const [filterResponsible, setFilterResponsible] = useState<string | null>(null);

  const isSuperuser = settings?.role === "admin";
  const effectiveResponsible = filterResponsible ?? currentUser?._id ?? "";

  const runSync = useCallback(async () => {
    setSyncError(null);
    try {
      const result = await synchroniserMaintenant();
      setSyncResult(result);
      setLastSyncAt(new Date().toISOString());
      if (result.errors.length > 0) {
        console.warn("[sync] erreurs:", result.errors);
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    }
  }, [synchroniserMaintenant]);

  const allDossiers = useMemo(() => dossiers ?? [], [dossiers]);

  const filtered = useMemo(() => {
    const q = normalise(search.trim());
    return allDossiers.filter((d) => {
      if (q) {
        const hay = normalise(
          `${d.payer_first_name} ${d.payer_last_name} ${d.payer_email} ${d.first_name} ${d.last_name}`
        );
        if (!hay.includes(q)) return false;
      }
      if (filterStatus) {
        if (filterStatus === "Suivi Remboursements") {
          if (!d.needs_refund_action) return false;
        } else if ((d.local_status ?? "À traiter") !== filterStatus) {
          return false;
        }
      }
      if (filterType === "1x" && d.is_installment) return false;
      if (filterType === "3x" && !d.is_installment) return false;
      if (effectiveResponsible) {
        if (effectiveResponsible === "none") {
          if (d.responsible_id !== null) return false;
        } else if (d.responsible_id !== effectiveResponsible) {
          return false;
        }
      }
      return true;
    });
  }, [allDossiers, search, filterStatus, filterType, effectiveResponsible]);

  const loading = dossiers === undefined;
  const resps = responsibles ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="pay-header">
        <span className="pay-tag">Validation</span>
        <h1>Liste des dossiers</h1>
      </div>

      {/* Barre de sync */}
      <div className="pay-toolbar">
        <button
          className="pay-btn pay-btn-dark"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing ? "⟳ Sync…" : "⟳ Sync HelloAsso"}
        </button>
        <span className="pay-sync-info">
          {lastSyncAt
            ? new Date(lastSyncAt).toLocaleTimeString("fr-FR")
            : "Pas encore synchronisé"}
        </span>
        {syncResult && syncResult.synced_count > 0 && (
          <span className="pay-sync-ok">
            +{syncResult.synced_count} importé
            {syncResult.synced_count > 1 ? "s" : ""}
          </span>
        )}
        {syncError && (
          <span style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "#c62828" }}>
            Sync : {syncError}
          </span>
        )}
        {syncResult?.errors && syncResult.errors.length > 0 && (
          <span
            style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "#ea580c" }}
            title={syncResult.errors.join("\n")}
          >
            ⚠ {syncResult.errors.length} erreur
            {syncResult.errors.length > 1 ? "s" : ""} (survol)
          </span>
        )}
      </div>

      {!loading && <StatsBar dossiers={allDossiers} />}

      {!loading && isSuperuser && (
        <StatsByResponsible dossiers={allDossiers} responsibles={resps} />
      )}

      {/* Filtres */}
      <div className="pay-filters">
        <input
          className="pay-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher…"
          style={{ width: "10rem" }}
        />
        <select
          className="pay-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">Tous</option>
          <option value="À traiter">À traiter</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value}
            </option>
          ))}
          <option value="Suivi Remboursements">Suivi Remboursements</option>
        </select>
        <select
          className="pay-select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="">1× et 3×</option>
          <option value="1x">1× seulement</option>
          <option value="3x">3× seulement</option>
        </select>
        <select
          className="pay-select"
          value={effectiveResponsible}
          onChange={(e) => setFilterResponsible(e.target.value)}
        >
          <option value="">Tous les responsables</option>
          {resps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
          <option value="none">Sans responsable</option>
        </select>
        {(search || filterType || effectiveResponsible || filterStatus !== "À traiter") && (
          <button
            className="pay-btn pay-btn-sm"
            onClick={() => {
              setSearch("");
              setFilterStatus("À traiter");
              setFilterType("");
              setFilterResponsible("");
            }}
          >
            ↺ Reset
          </button>
        )}
      </div>

      {/* Liste */}
      <section className="pay-section">
        <div className="pay-section-head">
          <h2>
            Dossiers{" "}
            <span className="count">
              {filtered.length !== allDossiers.length
                ? `${filtered.length} / ${allDossiers.length}`
                : `(${allDossiers.length})`}
            </span>
          </h2>
        </div>
        <div className="pay-section-body">
          {loading && <p className="pay-muted">Chargement…</p>}

          {!loading && allDossiers.length === 0 && (
            <div style={{ padding: "2rem", textAlign: "center" }}>
              <p className="pay-muted" style={{ padding: 0 }}>
                Aucun paiement à afficher.
              </p>
              <p style={{ fontSize: "0.78rem", color: "#aaa", marginTop: "0.5rem" }}>
                Vérifiez vos liens HelloAsso dans la page Config et lancez une
                synchronisation.
              </p>
            </div>
          )}

          {!loading && allDossiers.length > 0 && filtered.length === 0 && (
            <p className="pay-muted" style={{ textAlign: "center" }}>
              {filterStatus === "À traiter"
                ? "✓ Tous les dossiers ont été traités !"
                : "Aucun dossier ne correspond aux filtres."}
            </p>
          )}

          {!loading &&
            filtered.map((d) => (
              <DossierCard
                key={d.id}
                dossier={d}
                responsibles={resps}
                approvedStudents={approvedStudents ?? []}
                waitingStudents={waitingStudents ?? []}
                onSave={async (status, comment) => {
                  await setDossierStatus({ dossier_id: d.id, status, comment });
                }}
                onReset={async () => {
                  await resetDossierStatus({ dossier_id: d.id });
                }}
              />
            ))}
        </div>
      </section>
    </div>
  );
}
