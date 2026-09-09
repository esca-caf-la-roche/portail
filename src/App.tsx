import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { SeasonProvider } from "./contexts/SeasonContext";
import Layout from "./components/Layout";
import RequireAccess from "./components/RequireAccess";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Configurations from "./pages/Configurations";
import LicencesEnCours from "./pages/LicencesEnCours";
import ContactsCours from "./pages/ContactsCours";
import ContactsCoursCopie from "./pages/ContactsCoursCopie";
import RemboursementsEleves from "./pages/RemboursementsEleves";
import Compteur from "./abonnements/Compteur";

const Compta = lazy(() => import("./pages/Compta"));
const MasseSalariale = lazy(() => import("./pages/Budget/MasseSalariale"));
const ParametresPaie = lazy(() => import("./pages/Budget/ParametresPaie"));
const PaiementsLayout = lazy(() => import("./pages/Paiements/Layout"));
const ValidationPaiements = lazy(() => import("./pages/Paiements/Validation"));
const ConfigPaiements = lazy(() => import("./pages/Paiements/Configurations"));
const ApprobationsPaiements = lazy(() => import("./pages/Paiements/Approbations"));
const AttentePaiements = lazy(() => import("./pages/Paiements/Attente"));
const AboApp = lazy(() => import("./abonnements/AboApp"));
const AboAdmin = lazy(() => import("./abonnements/admin/AboAdmin"));
const ApercuAbonne = lazy(() => import("./abonnements/admin/ApercuAbonne"));
const SamedisApp = lazy(() => import("./samedis/SamedisApp"));
const GestionSamedis = lazy(() => import("./pages/GestionSamedis"));
const PlanningSalariesApp = lazy(() => import("./planningSalariesSamedis/PlanningSalariesApp"));
const GestionPlanningSalaries = lazy(() => import("./planningSalariesSamedis/GestionPlanningSalaries"));

function RouteLoadingFallback() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      Chargement de la page...
    </div>
  );
}

class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { erreur: boolean }
> {
  state = { erreur: false };

  static getDerivedStateFromError() {
    return { erreur: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Échec du chargement de la route", error, info);
  }

  render() {
    if (this.state.erreur) {
      return (
        <main className="loading-screen" role="alert" aria-labelledby="route-error-title">
          <h1 id="route-error-title">La page n’a pas pu être chargée</h1>
          <p>Une nouvelle version de l’application est peut-être disponible.</p>
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            Recharger la page
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}

function LazyRoute({ children }: { children: ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteLoadingFallback />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

// Composant temporaire pour les routes non implémentées
const Placeholder = ({ title }: { title: string }) => (
  <div className="p-8 text-center">
    <h2 className="text-2xl font-bold mb-4">{title}</h2>
    <p>Ce module est en cours de développement.</p>
  </div>
);

function App() {
  return (
    <HashRouter>
      <SeasonProvider>
          <Routes>
            <Route path="/login" element={<Login />} />

            {/* Espace PUBLIC abonnés — isolé, hors du Layout compta.
                Les abonnés n'ont pas connaissance de l'outil de gestion. */}
            <Route path="/abonnements" element={<LazyRoute><AboApp /></LazyRoute>} />
            <Route path="/samedis" element={<LazyRoute><SamedisApp /></LazyRoute>} />
            <Route path="/planning-salaries-samedis" element={<LazyRoute><PlanningSalariesApp /></LazyRoute>} />

            {/* Compteur public ANONYME (iframe embarquable sur le site club) —
                hors Layout et hors auth ; ne renvoie que des nombres. */}
            <Route path="/compteur" element={<Compteur />} />

            {/* Routes protégées. Chaque module est gardé par RequireAccess :
                accès uniquement si la tuile est cochée (même pour un admin). */}
            <Route element={<Layout />}>
              {/* Gestion des abonnements (staff), atteinte par la tuile */}
              <Route path="/gestion-abonnements" element={<RequireAccess tile="abonnements"><LazyRoute><AboAdmin /></LazyRoute></RequireAccess>} />
              <Route path="/gestion-abonnements/apercu/:dossierId" element={<RequireAccess tile="abonnements"><LazyRoute><ApercuAbonne /></LazyRoute></RequireAccess>} />
              <Route path="/" element={<Dashboard />} />
              <Route path="/compta" element={<RequireAccess tile="compta"><LazyRoute><Compta /></LazyRoute></RequireAccess>} />
              <Route path="/budget" element={<RequireAccess tile="budget"><LazyRoute><MasseSalariale /></LazyRoute></RequireAccess>} />
              <Route path="/budget/parametres" element={<RequireAccess tile="budget"><LazyRoute><ParametresPaie /></LazyRoute></RequireAccess>} />
              <Route path="/configurations" element={<RequireAccess admin><Configurations /></RequireAccess>} />
              <Route path="/licences-cours" element={<RequireAccess tile="licences_cours"><LicencesEnCours /></RequireAccess>} />
              <Route path="/contacts-cours" element={<RequireAccess tile="contacts_cours"><ContactsCours /></RequireAccess>} />
              <Route path="/contacts-cours/copier" element={<RequireAccess tile="contacts_cours"><ContactsCoursCopie /></RequireAccess>} />
              <Route path="/remboursements-eleves" element={<RequireAccess tile="remboursements_eleves"><RemboursementsEleves /></RequireAccess>} />
              <Route path="/gestion-samedis" element={<RequireAccess tile="samedis"><LazyRoute><GestionSamedis /></LazyRoute></RequireAccess>} />
              <Route path="/gestion-planning-salaries-samedis" element={<RequireAccess tile="planning_salaries_samedis"><LazyRoute><GestionPlanningSalaries /></LazyRoute></RequireAccess>} />

              {/* Routes Paiements */}
              <Route path="/paiements" element={<RequireAccess tile="paiements"><LazyRoute><PaiementsLayout /></LazyRoute></RequireAccess>}>
                <Route index element={<LazyRoute><ValidationPaiements /></LazyRoute>} />
                <Route path="config" element={<LazyRoute><ConfigPaiements /></LazyRoute>} />
                <Route path="approbations" element={<LazyRoute><ApprobationsPaiements /></LazyRoute>} />
                <Route path="attente" element={<LazyRoute><AttentePaiements /></LazyRoute>} />
              </Route>

              <Route path="/adherents" element={<Placeholder title="Module Adhérents" />} />
              <Route path="/evenements" element={<Placeholder title="Module Événements" />} />
              <Route path="/statistiques" element={<Placeholder title="Module Statistiques" />} />
            </Route>
          </Routes>
      </SeasonProvider>
    </HashRouter>
  );
}

export default App;
