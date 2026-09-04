import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { aboError } from "./lib/errors";

type Cible =
  | { type: "direct"; candidatId: Id<"abo_test_candidats_directs"> }
  | { type: "dossier"; personneId: Id<"abo_personnes"> };

export default function NotificationDisponibilitesTest({ cible, masquerSiInactif = false }: { cible: Cible; masquerSiInactif?: boolean }) {
  const suivis = useQuery(api.abo.testNotifications.mesSuivisDisponibilites);
  const suivreDirect = useMutation(api.abo.testNotifications.suivreCandidatDirect);
  const suivreDossier = useMutation(api.abo.testNotifications.suivrePersonneDossier);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cle = cible.type === "direct" ? `direct:${cible.candidatId}` : `dossier:${cible.personneId}`;
  const actif = suivis?.some((suivi) => suivi.cle === cle && suivi.statut === "en_attente") ?? false;

  async function changer() {
    setBusy(true);
    setMessage(null);
    try {
      if (cible.type === "direct") await suivreDirect({ candidatId: cible.candidatId, actif: !actif });
      else await suivreDossier({ personneId: cible.personneId, actif: !actif });
      setMessage(actif ? "Alerte désactivée." : "Vous recevrez un e-mail lorsque de nouveaux créneaux seront disponibles.");
    } catch (error) {
      setMessage(aboError(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (masquerSiInactif && suivis !== undefined && !actif) return null;
  return (
    <div className="abo-alerte-creneaux">
      <p>{actif ? "Alerte e-mail activée pour cette personne." : "Vous pouvez être prévenu·e par e-mail lorsque des créneaux seront ajoutés."}</p>
      <button type="button" className="abo-link" disabled={busy || suivis === undefined} onClick={changer}>
        {busy ? "Enregistrement…" : actif ? "Ne plus me prévenir" : "Me prévenir par e-mail"}
      </button>
      {message && <p className="abo-resa-information" role="status">{message}</p>}
    </div>
  );
}
