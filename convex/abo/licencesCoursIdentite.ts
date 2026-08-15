import { normaliserNomPrenom } from "./lib";

export type LigneIdentiteLicenceCours = {
  nom?: string;
  prenom?: string;
  nom_prenom_normalise?: string;
  date_naissance?: string;
  email_eleve?: string;
  email_gestion?: string;
};

export type IdentiteLicenceCours = {
  cle: string;
};

function emailNormalise(ligne: LigneIdentiteLicenceCours): string | undefined {
  const emailEleve = (ligne.email_eleve ?? "").trim();
  const emailGestion = (ligne.email_gestion ?? "").trim();
  const email = emailEleve || emailGestion;
  return email ? email.toLocaleLowerCase("fr") : undefined;
}

export function nomNormaliseLicenceCours(
  ligne: LigneIdentiteLicenceCours,
): string {
  return (
    ligne.nom_prenom_normalise?.trim() ||
    normaliserNomPrenom(ligne.nom, ligne.prenom)
  );
}

/**
 * Construit une identité indépendante de l'_id du snapshot.
 *
 * Le nom seul n'est accepté que s'il n'apparaît qu'une fois dans le snapshot :
 * en cas d'homonymie (ou de plusieurs inscriptions impossibles à distinguer),
 * le staff doit attendre la prochaine synchronisation ou compléter la source.
 */
export function construireIdentiteLicenceCours(
  ligne: LigneIdentiteLicenceCours,
  occurrencesParNom: ReadonlyMap<string, number>,
): IdentiteLicenceCours | null {
  const nomPrenomNormalise = nomNormaliseLicenceCours(ligne);
  if (!nomPrenomNormalise) return null;

  const dateNaissance = (ligne.date_naissance ?? "").trim() || undefined;
  if (dateNaissance) {
    return {
      cle: JSON.stringify(["nom_date_naissance", nomPrenomNormalise, dateNaissance]),
    };
  }

  const email = emailNormalise(ligne);
  if (email) {
    // Le nom reste dans la clé car une adresse de gestion peut être partagée
    // entre plusieurs enfants d'une même famille.
    return {
      cle: JSON.stringify(["email", nomPrenomNormalise, email]),
    };
  }

  if (occurrencesParNom.get(nomPrenomNormalise) === 1) {
    return {
      cle: JSON.stringify(["nom_unique", nomPrenomNormalise]),
    };
  }

  return null;
}

export function compterOccurrencesParNom(
  lignes: readonly LigneIdentiteLicenceCours[],
): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const ligne of lignes) {
    const nom = nomNormaliseLicenceCours(ligne);
    if (nom) occurrences.set(nom, (occurrences.get(nom) ?? 0) + 1);
  }
  return occurrences;
}
