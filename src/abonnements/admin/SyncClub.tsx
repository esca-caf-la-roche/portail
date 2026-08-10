import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { aboError } from "../lib/errors";

function formatRetryAt(value: string | null): string {
  if (!value) return "dans quelques minutes";
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

// Bouton admin « Synchroniser le site club » (Phase H). Déclenche à la demande le
// scrap des abonnés (+ matching) puis l'import des élèves en cours — les mêmes
// tâches que les crons horaires. Réservé aux admins (garde côté serveur).
export default function SyncClub() {
  const synchroniser = useAction(api.abo.scrap.synchroniserClub);
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  async function lancer() {
    setEnCours(true);
    setMessage(null);
    setErreur(null);
    try {
      const r = await synchroniser({});
      setMessage(
        r.statut === "desactive"
          ? "Aucun import Abonnements n'a été effectué : les imports externes sont bloqués pour la nouvelle saison. Réactivez-les dans Configuration lorsque les données du site club sont prêtes."
          : r.statut === "skipped"
          ? `Synchronisation déjà lancée récemment. Réessayez à partir de ${formatRetryAt(r.retryAt)}.`
          : `Abonnés : ${r.abonnes.upsertees} synchronisés, ${r.abonnes.supprimees} retiré(s) du cache, ${r.abonnes.maj} personne(s) mise(s) à jour. ` +
            `Élèves en cours : ${r.eleves.avecLicence + r.eleves.sansLicence} importé(s).`,
      );
    } catch (err) {
      setErreur(aboError(err).message);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="abo-admin-toolbar abo-admin-sync">
      <button
        type="button"
        onClick={lancer}
        disabled={enCours}
        className="abo-admin-button"
      >
        {enCours ? "Synchronisation…" : "Synchroniser le site club"}
      </button>
      {message && <span className="abo-admin-status abo-admin-status--success">{message}</span>}
      {erreur && <span className="abo-admin-status abo-admin-status--error">{erreur}</span>}
    </div>
  );
}
