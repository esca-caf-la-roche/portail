import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Navigate } from "react-router-dom";
import { CircleAlert, Clock3, LogOut } from "lucide-react";
import { api } from "../../convex/_generated/api";
import SamediLogin from "./SamediLogin";
import ParticipantCalendar from "./ParticipantCalendar";
import "./samedis.css";

export default function SamedisApp() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const identity = useQuery(api.samedis.identity.me, isAuthenticated ? {} : "skip");

  if (isLoading) return <div className="samedis-state samedis-state--screen" role="status"><Clock3 aria-hidden="true" /> Chargement…</div>;
  if (!isAuthenticated) return <div className="samedis-root"><SamediLogin /></div>;
  if (identity === undefined) return <div className="samedis-state samedis-state--screen" role="status"><Clock3 aria-hidden="true" /> Vérification de votre accès…</div>;
  if (identity.gestionnaire) return <Navigate to="/gestion-samedis" replace />;
  if (!identity.autorise || !identity.participant) {
    return <main className="samedis-root samedis-denied"><section className="samedis-login-card"><CircleAlert aria-hidden="true" /><h1>Accès indisponible</h1><p>Cette adresse n’est pas autorisée à réserver la salle le samedi. Contactez le club si vous pensez qu’il s’agit d’une erreur.</p><button className="samedis-button samedis-button--primary" onClick={() => void signOut()}><LogOut aria-hidden="true" /> Essayer une autre adresse</button></section></main>;
  }
  return <div className="samedis-root"><ParticipantCalendar /></div>;
}
