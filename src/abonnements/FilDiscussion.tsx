import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { aboError } from "./lib/errors";

// Fil de discussion partagé (abonné ↔ admins) d'un dossier. Réactif Convex =
// temps réel : getFil se réabonne à chaque nouveau message. Utilisé côté public
// (Suivi) ET côté admin (modal Dossiers). L'alignement des bulles suit `est_moi`.
//
// Styles inline néo-brutalistes (angles droits, bordures noires épaisses, ombres
// portées dures) pour s'intégrer AUX DEUX thèmes : l'espace public (abo.css) et
// l'espace admin (thème compta index.css) partagent cette identité visuelle.

const INK = "#111";
const ACCENT = "#ff5a1f";

function heure(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FilDiscussion({
  dossierId,
  hauteur = 280,
}: {
  dossierId: Id<"abo_dossiers">;
  hauteur?: number;
}) {
  const fil = useQuery(api.abo.messages.getFil, { dossierId });
  const envoyer = useMutation(api.abo.messages.envoyerMessage);
  const marquerLu = useMutation(api.abo.messages.marquerLu);

  const cleBrouillon = `abo-message-brouillon-${dossierId}`;
  const [texte, setTexte] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem(cleBrouillon) ?? "";
  });
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  // Marque le fil comme lu à l'ouverture et dès qu'un nouveau message arrive.
  const nb = fil?.length ?? 0;
  useEffect(() => {
    if (fil && fil.length > 0) void marquerLu({ dossierId });
  }, [dossierId, nb, fil, marquerLu]);

  // Auto-scroll vers le dernier message.
  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [nb]);

  async function soumettre(e: React.FormEvent) {
    e.preventDefault();
    const contenu = texte.trim();
    if (!contenu || envoiEnCours) return;
    setEnvoiEnCours(true);
    setErreur(null);
    try {
      await envoyer({ dossierId, contenu });
      setTexte("");
      window.sessionStorage.removeItem(cleBrouillon);
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setEnvoiEnCours(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div
        style={{
          height: hauteur,
          overflowY: "auto",
          border: `2px solid ${INK}`,
          padding: "0.75rem",
          background: "#fafafa",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        {fil === undefined ? (
          <p style={{ color: "#9ca3af", margin: 0 }}>Chargement…</p>
        ) : fil.length === 0 ? (
          <p style={{ color: "#9ca3af", margin: "auto", fontSize: "0.9rem" }}>
            Aucun message. Écrivez le premier ci-dessous.
          </p>
        ) : (
          fil.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.est_moi ? "flex-end" : "flex-start",
                maxWidth: "80%",
                background: m.est_moi ? INK : "#fff",
                color: m.est_moi ? "#fff" : INK,
                border: `2px solid ${INK}`,
                boxShadow: `2px 2px 0 0 ${INK}`,
                padding: "0.5rem 0.75rem",
              }}
            >
              <div style={{ fontSize: "0.7rem", opacity: 0.7, marginBottom: 2 }}>
                {m.auteur_role === "admin" ? "Commission escalade" : "Abonné·e"} ·{" "}
                {heure(m.created_at)}
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>{m.contenu}</div>
            </div>
          ))
        )}
        <div ref={finRef} />
      </div>

      <form onSubmit={soumettre} style={{ display: "flex", gap: "0.5rem" }}>
        <textarea
          value={texte}
          onChange={(e) => {
            const prochain = e.target.value;
            setTexte(prochain);
            window.sessionStorage.setItem(cleBrouillon, prochain);
          }}
          aria-label="Votre réponse"
          placeholder="Votre message…"
          rows={2}
          style={{
            flex: 1,
            resize: "vertical",
            padding: "0.5rem",
            border: `2px solid ${INK}`,
            fontFamily: "inherit",
            fontSize: "0.9rem",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void soumettre(e);
          }}
        />
        <button
          type="submit"
          disabled={envoiEnCours || !texte.trim()}
          style={{
            background: ACCENT,
            color: "#fff",
            border: `2px solid ${INK}`,
            boxShadow: `3px 3px 0 0 ${INK}`,
            padding: "0 1rem",
            fontWeight: 800,
            cursor: envoiEnCours || !texte.trim() ? "default" : "pointer",
            opacity: envoiEnCours || !texte.trim() ? 0.5 : 1,
          }}
        >
          Envoyer
        </button>
      </form>
      {erreur && <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", margin: 0 }}>{erreur}</p>}
    </div>
  );
}
