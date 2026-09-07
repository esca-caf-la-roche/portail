import { createContext, useContext, useMemo, useState } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useLocation } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { moduleSaisonnier, saisonParDefaut } from "./seasonRouting";

interface SeasonContextType {
  season: string;
  setSeason: (season: string) => void;
  availableSeasons: string[];
}

const SeasonContext = createContext<SeasonContextType | undefined>(undefined);

function SeasonSelectionProvider({
  children,
  defaultSeason,
  availableSeasons,
}: {
  children: React.ReactNode;
  defaultSeason: string;
  availableSeasons: string[];
}) {
  // Ce state vit uniquement tant que la racine du module ne change pas. Le
  // choix manuel est donc conservé dans les sous-routes, jamais entre deux
  // entrées dans une tuile ni entre deux chargements de l'application.
  const [season, setSeasonState] = useState(defaultSeason);
  const setSeason = (newSeason: string) => {
    if (availableSeasons.includes(newSeason)) setSeasonState(newSeason);
  };

  return (
    <SeasonContext.Provider value={{ season, setSeason, availableSeasons }}>
      {children}
    </SeasonContext.Provider>
  );
}

export const SeasonProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useConvexAuth();
  const location = useLocation();
  const dbSaisons = useQuery(api.saisons.get, isAuthenticated ? undefined : "skip");
  const availableSeasons = useMemo(
    () => dbSaisons?.map((saison) => saison.nom) ?? [],
    [dbSaisons],
  );
  const defaultSeason = saisonParDefaut(dbSaisons);
  const moduleKey = moduleSaisonnier(location.pathname);

  // Les écrans anonymes (login, compteur et formulaires OTP publics) restent
  // disponibles. Une fois authentifié, aucun écran métier ne peut lancer une
  // requête avec une saison provisoire pendant le chargement de Convex.
  if (isAuthenticated && dbSaisons === undefined) {
    return <div className="loading-screen" role="status">Chargement de la saison…</div>;
  }

  if (isAuthenticated && moduleKey && !defaultSeason) {
    return (
      <main className="loading-screen" role="alert">
        Aucune saison par défaut n’est configurée. Un administrateur doit en définir une.
      </main>
    );
  }

  // Hors authentification, les composants qui consomment la saison ne sont
  // pas encore rendus. La valeur vide n'est donc jamais envoyée au backend.
  const initialSeason = defaultSeason ?? "";

  return (
    <SeasonSelectionProvider
      key={`${moduleKey ?? "hors-module"}:${initialSeason}`}
      defaultSeason={initialSeason}
      availableSeasons={availableSeasons}
    >
      {children}
    </SeasonSelectionProvider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSeason = () => {
  const context = useContext(SeasonContext);
  if (context === undefined) {
    throw new Error("useSeason must be used within a SeasonProvider");
  }
  return context;
};
