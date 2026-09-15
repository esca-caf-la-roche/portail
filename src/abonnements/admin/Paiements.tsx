import { useMemo, useState } from "react";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { aboError } from "../lib/errors";
import { SANS_ARGUMENTS, useQueryPonctuelle } from "../../hooks/useQueryPonctuelle";

function formatRetryAt(value: string | null): string {
  if (!value) return "dans quelques minutes";
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

// Vue admin « Paiements » : cache HelloAsso du formulaire abonnements. Cards avec
// statut interne (boutons), commentaire (Remboursé / En attente), timeline des
// remboursements et détection d'un problème de remboursement (divergence statut
// interne ↔ HelloAsso). Portage de admin-paiements.js. Le statut interne est un
// suivi ; il n'affecte pas les étapes (le paiement « officiel » vient du scrap).

type Reponse = FunctionReturnType<typeof api.abo.paiements.getPaiementsAbo>;
type Paiement = Reponse["paiements"][number];

const STATUTS: Record<string, string> = {
  a_traiter: "À traiter",
  traite: "Traité",
  rembourse: "Remboursé",
  en_attente: "En attente",
};
const AVEC_COMMENTAIRE = new Set(["rembourse", "en_attente"]);
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

const dateHeureFr = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
const majNom = (s: string | null) => (s ?? "").toUpperCase();
const capPrenom = (s: string | null) =>
  (s ?? "").toLowerCase().replace(/(^|[\s'’-])([a-zà-ÿ])/g, (_, sep, c) => sep + c.toUpperCase());

function messageProbleme(p: Paiement): string {
  if (!p.besoin_action_remboursement) return "";
  return p.statut_local === "rembourse"
    ? "⚠ Marqué « Remboursé » mais aucun remboursement HelloAsso"
    : "⚠ Remboursé sur HelloAsso mais pas marqué « Remboursé » ici";
}

export default function Paiements({ versionSources = 0 }: { versionSources?: number }) {
  const {
    data: reponse,
    erreur: erreurChargement,
    recharger,
  } = useQueryPonctuelle(
    api.abo.paiements.getPaiementsAbo,
    SANS_ARGUMENTS,
    versionSources,
  );
  const setStatut = useMutation(api.abo.paiements.setStatutPaiementAbo);
  const enregistrerLien = useMutation(api.abo.paiements.enregistrerLienAbo);
  const synchroniser = useAction(api.abo.paiements.synchroniserPaiementsAbo);

  const [statut, setStatutFiltre] = useState("a_traiter");
  const [q, setQ] = useState("");
  const [problemes, setProblemes] = useState(false);
  const [sync, setSync] = useState<string | null>(null);

  const paiements = useMemo(() => reponse?.paiements ?? [], [reponse]);
  const nbProblemes = paiements.filter((p) => p.besoin_action_remboursement).length;

  const filtres = useMemo(() => {
    const texte = q.trim().toLowerCase();
    return paiements.filter((p) => {
      if (problemes && !p.besoin_action_remboursement) return false;
      if (statut !== "tous" && p.statut_local !== statut) return false;
      if (!texte) return true;
      const foin = [
        p.inscrit_prenom, p.inscrit_nom, p.inscrit_email,
        p.payeur_prenom, p.payeur_nom, p.payeur_email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return foin.includes(texte);
    });
  }, [paiements, statut, q, problemes]);

  async function lancerSync() {
    setSync("Synchronisation…");
    try {
      const r = await synchroniser({});
      await recharger();
      setSync(
        r.statut === "skipped"
          ? `Synchronisation déjà lancée récemment. Réessayez à partir de ${formatRetryAt(r.retryAt)}.`
          : r.errors.length
          ? `Terminé avec ${r.errors.length} erreur(s) : ${r.errors[0]}`
          : `✓ ${r.synced_count} transaction(s) Abonnements synchronisée(s).`,
      );
    } catch (err) {
      setSync(`Échec : ${aboError(err).message}`);
    }
  }

  if (reponse === undefined) {
    return <p>{erreurChargement ? "Impossible de charger les paiements." : "Chargement…"}</p>;
  }
  if (!reponse.configured) {
    return (
      <>
        <ConfigLien enregistrer={async (args) => {
          const resultat = await enregistrerLien(args);
          await recharger();
          return resultat;
        }} />
        {erreurChargement !== null && (
          <p className="abo-admin-status abo-admin-status--error" role="alert">
            Le lien est enregistré, mais l'actualisation a échoué. Rechargez l'affichage.
          </p>
        )}
      </>
    );
  }

  const compter = (s: string) => paiements.filter((p) => p.statut_local === s).length;

  return (
    <div className="abo-admin-section">
      <p className="abo-admin-intro">
        Cache du formulaire HelloAsso abonnements uniquement. Le statut interne est
        votre suivi d'arbitrage ; il n'affecte pas les étapes (le paiement « officiel »
        vient du scrap) ni le suivi des paiements des cours.
      </p>
      <div className="abo-admin-toolbar">
        <button type="button" className="abo-admin-button abo-admin-button--secondary" onClick={lancerSync}>
          🔄 Synchroniser maintenant
        </button>
        <button type="button" className="abo-admin-button" onClick={() => void recharger()}>
          Actualiser l'affichage
        </button>
        {sync && <span className="abo-admin-status">{sync}</span>}
      </div>

      {erreurChargement !== null && (
        <p className="abo-admin-status abo-admin-status--error" role="alert">
          L'actualisation des paiements a échoué. Les données affichées peuvent être anciennes.
        </p>
      )}

      {nbProblemes > 0 && (
        <p className="abo-admin-status abo-admin-status--warning">
          ⚠ {nbProblemes} problème(s) de remboursement à vérifier
        </p>
      )}

      <section className="abo-admin-payment-summary">
        {[["Total", paiements.length] as const, ...Object.entries(STATUTS).map(
          ([v, l]) => [l, compter(v)] as const,
        )].map(([label, n], i) => (
          <div
            key={label}
            className={`abo-admin-payment-stat${i === 0 ? " abo-admin-payment-stat--total" : ""}`}
          >
            <div className="abo-admin-payment-stat-value">{n}</div>
            <div className="abo-admin-payment-stat-label">{label}</div>
          </div>
        ))}
      </section>

      <div className="abo-admin-toolbar abo-admin-payment-filters">
        <label className="abo-admin-filter-field">
          <span>Statut</span>
          <select className="abo-admin-input abo-admin-select" value={statut} onChange={(e) => setStatutFiltre(e.target.value)}>
            <option value="tous">Tous</option>
            {Object.entries(STATUTS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="abo-admin-filter-field">
          <span>Recherche</span>
          <input
            type="search"
            placeholder="Nom ou email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="abo-admin-input abo-admin-search"
          />
        </label>
        <label className="abo-admin-check-label">
          <input type="checkbox" checked={problemes} onChange={(e) => setProblemes(e.target.checked)} />
          ⚠ Problèmes uniquement
        </label>
      </div>

      <p className="abo-admin-intro">
        {filtres.length} paiement{filtres.length > 1 ? "s" : ""}
      </p>

      <div className="abo-admin-card-grid">
        {filtres.length === 0 ? (
          <p className="abo-admin-empty">Aucun paiement ne correspond.</p>
        ) : (
          filtres.map((p) => (
            <Card
              key={p.id}
              p={p}
              adminUrl={reponse.adminUrl}
              setStatut={setStatut}
              onMisAJour={recharger}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Carte d'un paiement ──────────────────────────────────────────────
function Card({
  p,
  adminUrl,
  setStatut,
  onMisAJour,
}: {
  p: Paiement;
  adminUrl: string | null;
  setStatut: ReturnType<typeof useMutation<typeof api.abo.paiements.setStatutPaiementAbo>>;
  onMisAJour: () => Promise<Reponse | undefined>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [comment, setComment] = useState(p.commentaire ?? "");
  const [copie, setCopie] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inscrit = `${majNom(p.inscrit_nom)} ${capPrenom(p.inscrit_prenom)}`.trim() || "—";
  const payeur = `${majNom(p.payeur_nom)} ${capPrenom(p.payeur_prenom)}`.trim();
  const payeurDiff = payeur && payeur.toLowerCase() !== inscrit.toLowerCase();
  const probleme = messageProbleme(p);

  async function enregistrer(s: string, c: string | undefined) {
    setErr(null);
    try {
      await setStatut({
        dossierId: p.id as Id<"dossiers">,
        statut: s as "a_traiter" | "traite" | "rembourse" | "en_attente",
        commentaire: c,
      });
      await onMisAJour();
      setPending(null);
    } catch (e) {
      setErr(aboError(e).message);
    }
  }

  function onStatut(s: string) {
    if (s === p.statut_local) return;
    if (AVEC_COMMENTAIRE.has(s)) {
      setComment(p.commentaire ?? "");
      setPending(s);
    } else {
      void enregistrer(s, undefined); // statut sans commentaire → on l'efface
    }
  }

  async function rembourser() {
    const email = p.payeur_email || p.inscrit_email || "";
    if (email) {
      try {
        await navigator.clipboard.writeText(email);
        setCopie(true);
        setTimeout(() => setCopie(false), 2000);
      } catch {
        /* presse-papier indisponible : le lien s'ouvre quand même */
      }
    }
    if (adminUrl) window.open(adminUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <article
      className={`abo-admin-card abo-admin-payment-card${p.besoin_action_remboursement ? " abo-admin-card--attention" : ""}`}
    >
      <div className="abo-admin-card-header">
        <strong>{inscrit}</strong>
        <span className="abo-admin-payment-amount">{euros.format(p.montant ?? 0)}</span>
      </div>
      <div className="abo-admin-meta abo-admin-payment-meta">
        Payé le {dateHeureFr(p.date_paiement)} · {p.statut_helloasso ?? "—"}
        {p.ha_rembourse && (
          <span
            className="abo-admin-badge abo-admin-badge--danger"
          >
            Remboursé HA
          </span>
        )}
        {p.payeur_email && <div>✉ {p.payeur_email}</div>}
        {payeurDiff && <div>Payeur : {payeur}</div>}
      </div>

      {p.remboursements.map((r, i) => (
        <div key={i} className="abo-admin-payment-refund">
          ↩ Remboursé {euros.format(r.montant)} le {dateHeureFr(r.date)}
        </div>
      ))}
      {probleme && (
        <p className="abo-admin-status abo-admin-status--warning">
          {probleme}
        </p>
      )}

      <div className="abo-admin-toolbar abo-admin-payment-links">
        {p.recu_url && (
          <a className="abo-admin-link" href={p.recu_url} target="_blank" rel="noopener noreferrer">
            📄 Reçu
          </a>
        )}
        {p.attestation_url && (
          <a className="abo-admin-link" href={p.attestation_url} target="_blank" rel="noopener noreferrer">
            🧾 Reçu fiscal
          </a>
        )}
        {adminUrl && (
          <button
            type="button"
            onClick={rembourser}
            className="abo-admin-link-button"
          >
            ↩ Rembourser
          </button>
        )}
        {copie && <span className="abo-admin-status abo-admin-status--success">✓ Email copié</span>}
      </div>

      <div className="abo-admin-decision-group">
        {Object.entries(STATUTS).map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => onStatut(v)}
            className={`abo-admin-decision${p.statut_local === v ? " is-active" : ""}`}
          >
            {l}
          </button>
        ))}
      </div>

      {pending && (
        <div className="abo-admin-payment-comment-form">
          <textarea
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Commentaire…"
            className="abo-admin-input abo-admin-payment-comment"
          />
          <div className="abo-admin-toolbar">
            <button className="abo-admin-button" type="button" onClick={() => enregistrer(pending, comment.trim() || undefined)}>
              Confirmer
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="abo-admin-link-button"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {err && <p className="abo-admin-status abo-admin-status--error">Échec : {err}</p>}
      {!pending && p.commentaire && (
        <p className="abo-admin-payment-comment">💬 {p.commentaire}</p>
      )}
      {p.suivi_updater_email && (
        <p className="abo-admin-meta abo-admin-payment-updated">
          Statué par {p.suivi_updater_email}
          {p.suivi_updated_at ? ` le ${dateHeureFr(p.suivi_updated_at)}` : ""}
        </p>
      )}
    </article>
  );
}

// ── Configuration du lien (quand aucun formulaire n'est encore branché) ──
function ConfigLien({
  enregistrer,
}: {
  enregistrer: (args: { url: string }) => Promise<unknown>;
}) {
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function valider() {
    setMsg("Enregistrement…");
    try {
      await enregistrer({ url: url.trim() });
      setMsg("✓ Lien enregistré. Lancez une synchronisation pour importer les paiements.");
    } catch (err) {
      setMsg(`Échec : ${aboError(err).message}`);
    }
  }

  return (
    <div className="abo-admin-section abo-admin-payment-config">
      <p className="abo-admin-intro">
        Aucun formulaire HelloAsso n'est encore configuré pour les abonnements.
        Collez le lien public du formulaire de paiement des abonnements :
      </p>
      <div className="abo-admin-toolbar">
        <input
          type="url"
          placeholder="https://www.helloasso.com/associations/…/paiements/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="abo-admin-input abo-admin-payment-url"
        />
        <button type="button" className="abo-admin-button abo-admin-button--secondary" onClick={valider} disabled={!url.trim()}>
          Enregistrer
        </button>
      </div>
      {msg && <p className="abo-admin-status">{msg}</p>}
    </div>
  );
}
