import { lazy, Suspense, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

const Demande = lazy(() => import("./pages/Demande"));
const Suivi = lazy(() => import("./pages/Suivi"));
const TestAutonomieDirect = lazy(() => import("./pages/TestAutonomieDirectV2"));

function ChargementContenu({ message }: { message: string }) {
  return (
    <div className="abo-content" role="status" aria-live="polite">
      <p>{message}</p>
    </div>
  );
}

// Espace de l'abonné connecté (route /abonnements, authentifié). Aiguillage selon
// l'existence d'un dossier (getMonDossier, réactif) :
//   - pas de dossier → formulaire de demande ;
//   - dossier présent → tableau de suivi.
export default function AboEspace() {
  const [testDirect, setTestDirect] = useState(false);
  const { signOut } = useAuthActions();
  const me = useQuery(api.abo.identity.me);
  const dossier = useQuery(api.abo.demandes.getMonDossier);

  return (
    <div className="abo-espace">
      <header className="abo-topbar">
        <span className="abo-brand">Abonnements Escalade</span>
        <div className="abo-topbar-right">
          {me?.email && <code className="abo-email">{me.email}</code>}
          <button className="abo-link" onClick={() => void signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      <main>
        {dossier === undefined ? (
          <ChargementContenu message="Chargement de votre demande…" />
        ) : dossier === null ? (
          <Suspense fallback={<ChargementContenu message="Préparation du formulaire…" />}>
            <TestAutonomieDirect demande={<Demande />} />
          </Suspense>
        ) : testDirect ? (
          <Suspense fallback={<ChargementContenu message="Préparation du test d'autonomie…" />}>
            <button className="abo-link abo-retour-test-direct" type="button" onClick={() => setTestDirect(false)}>← Retour au suivi</button>
            <TestAutonomieDirect initialMode="test" demande={<Suivi dossier={dossier} />} />
          </Suspense>
        ) : (
          <Suspense fallback={<ChargementContenu message="Préparation du suivi…" />}>
            <Suivi dossier={dossier} />
            <div className="abo-content abo-acces-test-direct"><button className="abo-btn" type="button" onClick={() => setTestDirect(true)}>Réserver pour une autre licence déjà inscrite au club</button></div>
          </Suspense>
        )}
      </main>
    </div>
  );
}
