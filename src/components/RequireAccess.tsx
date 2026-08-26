import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { TileId } from "../config/tiles";

type Props = {
  children: ReactNode;
  /** Tuile requise (cochée dans Configurations > Utilisateurs). */
  tile?: TileId;
  /** Réservé au rôle admin (page Configurations uniquement). */
  admin?: boolean;
};

// Garde de route côté client : applique la règle de base — un module n'est
// accessible que si sa tuile est cochée dans Configurations > Utilisateurs,
// même pour un admin (le rôle admin ne sert qu'à la page Configurations).
// Défense en profondeur : les endpoints Convex portent la vraie sécurité.
export default function RequireAccess({ children, tile, admin }: Props) {
  const userSettings = useQuery(api.users.getCurrentUserSettings);

  if (userSettings === undefined) {
    return <div className="loading-screen">Chargement de vos accès...</div>;
  }

  const tileOk = !tile || (userSettings.allowedTiles ?? []).includes(tile);
  const adminOk = !admin || userSettings.role === "admin";

  if (!tileOk || !adminOk) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h2>Accès refusé</h2>
        <p style={{ color: "#6b7280", margin: "1rem 0" }}>
          {admin && !adminOk
            ? "Cette page est réservée aux administrateurs."
            : "Ce module ne vous est pas attribué. Contactez un administrateur."}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
