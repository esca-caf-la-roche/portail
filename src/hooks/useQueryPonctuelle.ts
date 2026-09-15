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

/**
 * Charge une query une fois, puis uniquement sur demande.
 *
 * À réserver aux vues volumineuses qui déclenchent elles-mêmes leur
 * synchronisation : un abonnement temps réel relirait sinon le snapshot après
 * chaque lot écrit par l'import. Les petites queries restent réactives.
 */
export function useQueryPonctuelle<Query extends QueryPublique>(
  query: Query,
  args: FunctionArgs<Query>,
  cleActualisation: string | number = 0,
) {
  const convex = useConvex();
  const requeteRef = useRef(0);
  const dernierSuccesRef = useRef(0);
  const [data, setData] = useState<FunctionReturnType<Query> | undefined>();
  const [erreur, setErreur] = useState<unknown>(null);
  const recharger = useCallback(async () => {
    const requete = ++requeteRef.current;
    setErreur(null);
    try {
      const resultat = await convex.query(query, args);
      if (requete === requeteRef.current) {
        dernierSuccesRef.current = Date.now();
        setData(resultat);
      }
      return resultat;
    } catch (error) {
      if (requete === requeteRef.current) setErreur(error);
      return undefined;
    }
  }, [args, convex, query]);

  useEffect(() => {
    const minuteur = window.setTimeout(() => void recharger(), 0);
    return () => window.clearTimeout(minuteur);
  }, [cleActualisation, recharger]);

  useEffect(() => {
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
  }, [recharger]);

  return { data, erreur, recharger };
}
