import { useEffect, useState } from "react";

const FORMAT_JOUR_PARIS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DUREE_MAX_RECHERCHE_MS = 26 * 60 * 60 * 1000;

/**
 * Fournit le jour civil en Europe/Paris et ne change qu'au passage au jour suivant.
 *
 * Les queries Convex reçoivent ainsi un argument stable pendant toute la journée,
 * tout en restant réactives aux modifications des tables auxquelles elles sont
 * abonnées. La frontière est recherchée dans le fuseau Paris : les passages à
 * l'heure d'été ou d'hiver sont donc pris en compte.
 */
function jourParis(maintenantMs = Date.now()): string {
  const morceaux = FORMAT_JOUR_PARIS.formatToParts(new Date(maintenantMs))
    .reduce<Record<string, string>>((resultat, morceau) => {
      resultat[morceau.type] = morceau.value;
      return resultat;
    }, {});
  return `${morceaux.year}-${morceaux.month}-${morceaux.day}`;
}

function prochainChangementJourParis(maintenantMs: number): number {
  const jourActuel = jourParis(maintenantMs);
  let debut = maintenantMs;
  let fin = maintenantMs + DUREE_MAX_RECHERCHE_MS;

  while (jourParis(fin) === jourActuel) fin += DUREE_MAX_RECHERCHE_MS;

  while (fin - debut > 1) {
    const milieu = Math.floor((debut + fin) / 2);
    if (jourParis(milieu) === jourActuel) debut = milieu;
    else fin = milieu;
  }

  return fin;
}

export function useMaintenantJourParis(): string {
  const [jour, setJour] = useState(jourParis);

  useEffect(() => {
    let timeout: number | undefined;

    const programmerMiseAJour = () => {
      const maintenantMs = Date.now();
      const prochainChangementMs = prochainChangementJourParis(maintenantMs);
      timeout = window.setTimeout(() => {
        setJour(jourParis());
        programmerMiseAJour();
      }, prochainChangementMs - maintenantMs + 50);
    };

    const actualiserAuRetourDansLAppli = () => {
      if (!document.hidden) setJour(jourParis());
    };

    programmerMiseAJour();
    document.addEventListener("visibilitychange", actualiserAuRetourDansLAppli);

    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", actualiserAuRetourDansLAppli);
    };
  }, []);

  return jour;
}
