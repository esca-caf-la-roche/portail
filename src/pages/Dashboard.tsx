import { Link } from "react-router-dom";
import Tile from "../components/Tile";
import {
  Calculator,
  Settings,
  CreditCard,
  PiggyBank,
  Mountain,
  ShieldCheck,
  Contact,
  HandCoins,
  CalendarCheck,
  Route,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  resolveDashboardTiles,
  type DashboardTileInput,
  type TileId,
} from "../config/tiles";

const TILE_DETAILS: Record<TileId, { icon: LucideIcon; to: string }> = {
  compta: { icon: Calculator, to: "/compta" },
  paiements: { icon: CreditCard, to: "/paiements" },
  budget: { icon: PiggyBank, to: "/budget" },
  abonnements: { icon: Mountain, to: "/gestion-abonnements" },
  licences_cours: { icon: ShieldCheck, to: "/licences-cours" },
  contacts_cours: { icon: Contact, to: "/contacts-cours" },
  remboursements_eleves: { icon: HandCoins, to: "/remboursements-eleves" },
  samedis: { icon: CalendarCheck, to: "/gestion-samedis" },
  planning_salaries_samedis: { icon: Route, to: "/gestion-planning-salaries-samedis" },
};

export default function Dashboard() {
  const userSettings = useQuery(api.users.getCurrentUserSettings);
  const configuration = useQuery(api.users.getDashboardConfiguration);
  const tiles = resolveDashboardTiles(
    configuration?.tiles as DashboardTileInput[] | undefined,
  );

  return (
    <div className="dashboard-page">
      <header
        className="page-header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <div>
          <h1>Tableau de bord</h1>
          <p className="subtitle">Sélectionnez un outil pour commencer.</p>
        </div>

        {userSettings?.role === "admin" && (
          <Link
            to="/configurations"
            className="btn-secondary"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", padding: "0.5rem 0.75rem", background: "transparent", border: "1px solid #e5e7eb", textDecoration: "none", color: "inherit" }}
          >
            <Settings size={16} /> Configurations
          </Link>
        )}
      </header>

      {userSettings === undefined || configuration === undefined ? (
        <div style={{ textAlign: "center", padding: "2rem" }}>
          Chargement de vos accès...
        </div>
      ) : (
        <div className="tiles-grid">
          {tiles
            .filter((tile) => userSettings.allowedTiles?.includes(tile.id))
            .map((tile) => {
              const details = TILE_DETAILS[tile.id];
              return (
                <Tile
                  key={tile.id}
                  title={tile.label}
                  description={tile.description}
                  icon={details.icon}
                  to={details.to}
                  colorClass={tile.color}
                />
              );
            })}

          {(!userSettings.allowedTiles || userSettings.allowedTiles.length === 0) && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "2rem", backgroundColor: "#f9fafb", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
              <p>Vous n'avez accès à aucun module. Veuillez contacter un administrateur.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
