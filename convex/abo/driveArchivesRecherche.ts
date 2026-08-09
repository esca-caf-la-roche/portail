export type DossierDrive = {
  id: string;
  nom: string;
};

export function echapperRequeteDrive(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function prenomTitre(prenom: string): string {
  return prenom
    .trim()
    .toLocaleLowerCase("fr-FR")
    .replace(/(^|[ -])([\p{L}])/gu, (_, prefix: string, letter: string) =>
      `${prefix}${letter.toLocaleUpperCase("fr-FR")}`,
    );
}

export function initialeNom(nom: string): string {
  const initiale = nom.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "")[0];
  return initiale ? initiale.toLocaleUpperCase("fr-FR") : "#";
}

export function preparerRechercheDrive(
  nom: string,
  prenom: string,
  dossiers: DossierDrive[],
) {
  const nomRecherche = nom.trim();
  const prenomRecherche = prenom.trim();
  const morceaux = [
    nomRecherche &&
      `name contains '${echapperRequeteDrive(nomRecherche.toLocaleUpperCase("fr-FR"))}'`,
    prenomRecherche &&
      `name contains '${echapperRequeteDrive(prenomTitre(prenomRecherche))}'`,
  ].filter((morceau): morceau is string => Boolean(morceau));
  const initialePrioritaire = nomRecherche ? initialeNom(nomRecherche) : null;
  const dossierIds = [...dossiers]
    .sort((a, b) => {
      const aPrioritaire = a.nom === initialePrioritaire ? 0 : 1;
      const bPrioritaire = b.nom === initialePrioritaire ? 0 : 1;
      return aPrioritaire - bPrioritaire || a.nom.localeCompare(b.nom, "fr-FR");
    })
    .map((dossier) => dossier.id);
  return { nomRecherche, prenomRecherche, morceaux, dossierIds };
}
