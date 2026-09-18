import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

type QueryPublique = FunctionReference<"query", "public">;

export const SANS_ARGUMENTS = {} as const;

const FRAICHEUR_AU_FOCUS_MS = 5 * 60_000;
const COOLDOWN_PAR_DEFAUT_MS = 30_000;

export type OptionsQueryPonctuelle = {
  /** Désactive le chargement au montage quand une synchronisation doit le précéder. */
  autoLoad?: boolean;
  /** Opt-in : les vues lourdes ne doivent pas relire au retour de focus. */
  refreshOnFocus?: boolean;
  /** Évite les lectures répétées des boutons « actualiser ». */
  cooldownMs?: number;
};

export type OptionsRechargementPonctuel = {
  /** À réserver à une mutation ou une synchronisation qui vient de réussir. */
  force?: boolean;
};

/**
 * Lit une query coûteuse à la demande, sans abonnement temps réel.
 *
 * La clé doit changer si les arguments métier changent. Une même instance ne
 * lance qu'une lecture à la fois ; les demandes concurrentes partagent cette
 * lecture et un cooldown absorbe les clics répétés. Par défaut, aucun retour de
 * focus ne relit les données : c'est intentionnel pour protéger le budget I/O.
 */
export function useQueryPonctuelle<Query extends QueryPublique>(
  query: Query,
  args: FunctionArgs<Query>,
  cleActualisation: string | number = 0,
  {
    autoLoad = true,
    refreshOnFocus = false,
    cooldownMs = COOLDOWN_PAR_DEFAUT_MS,
  }: OptionsQueryPonctuelle = {},
) {
  const convex = useConvex();
  const mountedRef = useRef(true);
  const queryRef = useRef(query);
  const argsRef = useRef(args);
  const cleRef = useRef(cleActualisation);
  const requeteRef = useRef(0);
  const requeteEnCoursRef = useRef<Promise<FunctionReturnType<Query> | undefined> | null>(null);
  const cleRequeteEnCoursRef = useRef<string | number | null>(null);
  const cleEnAttenteRef = useRef<string | number | null>(null);
  const dernierSuccesRef = useRef(0);
  const derniereCleSuccesRef = useRef<string | number | null>(null);
  const dataRef = useRef<FunctionReturnType<Query> | undefined>(undefined);
  const [data, setData] = useState<FunctionReturnType<Query> | undefined>();
  const [erreur, setErreur] = useState<unknown>(null);
  const [relanceDifferee, setRelanceDifferee] = useState(0);

  useEffect(() => {
    queryRef.current = query;
    argsRef.current = args;
    cleRef.current = cleActualisation;
  }, [args, cleActualisation, query]);

  const recharger = useCallback(async (options: OptionsRechargementPonctuel = {}) => {
    const force = options.force ?? false;
    const cle = cleRef.current;
    const enCours = requeteEnCoursRef.current;
    if (enCours) {
      // Une source a changé pendant une lecture : une seule lecture finale sera
      // faite après celle-ci, jamais deux lectures parallèles du même snapshot.
      if (cleRequeteEnCoursRef.current !== cle) cleEnAttenteRef.current = cle;
      return enCours;
    }

    const maintenant = Date.now();
    if (
      !force &&
      derniereCleSuccesRef.current === cle &&
      maintenant - dernierSuccesRef.current < cooldownMs
    ) {
      return dataRef.current;
    }

    const requete = ++requeteRef.current;
    if (mountedRef.current) setErreur(null);
    const promesse = convex
      .query(queryRef.current, argsRef.current)
      .then((resultat) => {
        if (requete === requeteRef.current) {
          dernierSuccesRef.current = Date.now();
          derniereCleSuccesRef.current = cle;
          dataRef.current = resultat;
          if (mountedRef.current) setData(resultat);
        }
        return resultat;
      })
      .catch((error: unknown) => {
        if (requete === requeteRef.current && mountedRef.current) setErreur(error);
        return undefined;
      })
      .finally(() => {
        if (requeteEnCoursRef.current !== promesse) return;
        requeteEnCoursRef.current = null;
        cleRequeteEnCoursRef.current = null;
        if (cleEnAttenteRef.current !== null) {
          const cleEnAttente = cleEnAttenteRef.current;
          cleEnAttenteRef.current = null;
          if (cleEnAttente === cleRef.current && mountedRef.current) {
            setRelanceDifferee((valeur) => valeur + 1);
          }
        }
      });

    requeteEnCoursRef.current = promesse;
    cleRequeteEnCoursRef.current = cle;
    return promesse;
  }, [convex, cooldownMs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (relanceDifferee === 0) return;
    void recharger({ force: true });
  }, [recharger, relanceDifferee]);

  useEffect(() => {
    if (!autoLoad) return;
    const minuteur = window.setTimeout(() => {
      // Une nouvelle clé représente une source effectivement modifiée : elle
      // doit pouvoir passer le cooldown, sans contourner le single-flight.
      void recharger({ force: derniereCleSuccesRef.current !== cleActualisation });
    }, 0);
    return () => window.clearTimeout(minuteur);
  }, [autoLoad, cleActualisation, recharger]);

  useEffect(() => {
    if (!refreshOnFocus) return;
    const actualiserAuFocus = () => {
      if (
        dernierSuccesRef.current !== 0 &&
        Date.now() - dernierSuccesRef.current >= FRAICHEUR_AU_FOCUS_MS
      ) {
        void recharger();
      }
    };
    window.addEventListener("focus", actualiserAuFocus);
    return () => window.removeEventListener("focus", actualiserAuFocus);
  }, [recharger, refreshOnFocus]);

  return { data, erreur, recharger };
}
