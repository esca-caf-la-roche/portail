import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Navigate } from "react-router-dom";
import { CircleAlert, Clock3, LogOut } from "lucide-react";
import { api } from "../../convex/_generated/api";
import PlanningSalariesLogin from "./PlanningSalariesLogin";
import PlanningBoard from "./PlanningBoard";
import "./planning-salaries.css";

export default function PlanningSalariesApp() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const identity = useQuery(api.planningSalaries.identity.me, isAuthenticated ? {} : "skip");
  if (isLoading) return <div className="pss-state pss-state--screen" role="status"><Clock3 aria-hidden="true" />Chargement…</div>;
  if (!isAuthenticated) return <div className="pss-root"><PlanningSalariesLogin /></div>;
  if (identity === undefined) return <div className="pss-state pss-state--screen" role="status"><Clock3 aria-hidden="true" />Vérification de votre accès…</div>;
  if (identity.gestionnaire) return <Navigate to="/gestion-planning-salaries-samedis" replace />;
  if (!identity.salarie) return <main className="pss-root pss-denied"><section className="pss-login-card"><CircleAlert aria-hidden="true" /><h1>Accès indisponible</h1><p>Cette adresse ne figure pas dans l’annuaire salarié actif.</p><button className="pss-button pss-button--primary" onClick={() => void signOut()}><LogOut aria-hidden="true" />Essayer une autre adresse</button></section></main>;
  return <PlanningBoard />;
}
