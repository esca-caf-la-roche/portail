import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import AboLogin from "./AboLogin";
import AboEspace from "./AboEspace";
import "./abo.css";

// Shell PUBLIC isolé des abonnés (route /abonnements, hors du Layout compta).
// Aucune référence à l'outil de gestion : un abonné ne sait pas qu'il existe.
export default function AboApp() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const identity = useQuery(api.abo.identity.me, isAuthenticated ? {} : "skip");

  return (
    <div className="abo-root">
      {isLoading || (isAuthenticated && identity === undefined) ? (
        <div className="abo-loading">Chargement…</div>
      ) : !isAuthenticated ? (
        <AboLogin />
      ) : identity === null ? (
        <main className="abo-login">
          <section className="abo-card" role="alert" aria-labelledby="abo-session-invalide-title">
            <h1 id="abo-session-invalide-title">Session non reconnue</h1>
            <p>
              Cette session ne correspond pas à un compte autorisé dans l’espace Abonnements.
            </p>
            <button type="button" className="abo-btn" onClick={() => void signOut()}>
              Se déconnecter et essayer une autre adresse
            </button>
          </section>
        </main>
      ) : (
        <AboEspace />
      )}
    </div>
  );
}
