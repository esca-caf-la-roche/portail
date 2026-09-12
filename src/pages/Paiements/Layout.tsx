import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useAction, useQuery } from "convex/react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import {
  DELAI_REVERIFICATION_SYNC_PAIEMENTS_MS,
  routePaiements,
  synchronisationPaiementsEnCours,
} from "./layoutState";

type Dossiers = NonNullable<ReturnType<typeof useQuery<typeof api.paiements.getDossiers>>>;
type DossiersTraites = NonNullable<
  ReturnType<typeof useQuery<typeof api.paiements.getDossiersTraitesIndex>>
>;
type ResultatSync = Awaited<
  ReturnType<ReturnType<typeof useAction<typeof api.helloasso.syncHelloAsso>>>
>;
export type PaiementsDossiersContextValue = {
  dossiers: Dossiers | undefined;
  dossiersTraites: DossiersTraites | undefined;
  syncing: boolean;
  synchroniserMaintenant: () => Promise<ResultatSync>;
};

const navClass = ({ isActive }: { isActive: boolean }) =>
  `pay-nav-link${isActive ? " active" : ""}`;

export default function PaiementsLayout() {
  const location = useLocation();
  const { surValidation, surIndexTraites } = routePaiements(location.pathname);
  const [syncing, setSyncing] = useState(false);
  const [autoSyncTerminee, setAutoSyncTerminee] = useState(false);
  const [derniersDossiers, setDerniersDossiers] = useState<Dossiers>();
  const syncPourPaiements = useAction(api.abo.sync.syncPourPaiements);
  const syncHelloAsso = useAction(api.helloasso.syncHelloAsso);
  const synchronisationEnCours = synchronisationPaiementsEnCours(
    surValidation,
    autoSyncTerminee,
    syncing,
  );

  useEffect(() => {
    if (!surValidation || autoSyncTerminee) return;
    let annule = false;
    void syncPourPaiements({})
      .catch((error) => {
        console.warn("[sync] synchro throttlée paiements échouée:", error);
      })
      .finally(() => {
        if (!annule) setAutoSyncTerminee(true);
      });
    return () => {
      annule = true;
    };
  }, [autoSyncTerminee, surValidation, syncPourPaiements]);

  useEffect(() => {
    if (!autoSyncTerminee) return;
    const timeout = setTimeout(
      () => setAutoSyncTerminee(false),
      DELAI_REVERIFICATION_SYNC_PAIEMENTS_MS,
    );
    return () => clearTimeout(timeout);
  }, [autoSyncTerminee]);

  const dossiersActuels = useQuery(
    api.paiements.getDossiers,
    surValidation && autoSyncTerminee && !syncing ? {} : "skip",
  );
  const dossiersTraites = useQuery(
    api.paiements.getDossiersTraitesIndex,
    surIndexTraites && !synchronisationEnCours ? {} : "skip",
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conserve le dernier résultat pendant la désinscription temporaire
    if (dossiersActuels !== undefined) setDerniersDossiers(dossiersActuels);
  }, [dossiersActuels]);

  const synchroniserMaintenant = useCallback(async () => {
    flushSync(() => {
      if (dossiersActuels !== undefined) setDerniersDossiers(dossiersActuels);
      setSyncing(true);
    });
    try {
      return await syncHelloAsso({});
    } finally {
      setSyncing(false);
    }
  }, [dossiersActuels, syncHelloAsso]);

  const contextValue = useMemo(
    () => ({
      dossiers: dossiersActuels ?? derniersDossiers,
      dossiersTraites,
      syncing: synchronisationEnCours,
      synchroniserMaintenant,
    }),
    [dossiersActuels, dossiersTraites, derniersDossiers, synchronisationEnCours, synchroniserMaintenant],
  );

  return (
    <div className="pay-layout">
        <nav className="pay-nav">
          <NavLink to="/paiements" end className={navClass}>
            Validation
          </NavLink>
          <NavLink to="/paiements/config" className={navClass}>
            Config
          </NavLink>
          <NavLink to="/paiements/approbations" className={navClass}>
            Approbations
          </NavLink>
          <NavLink to="/paiements/attente" className={navClass}>
            Attente
          </NavLink>
        </nav>
      <Outlet context={contextValue} />
    </div>
  );
}
