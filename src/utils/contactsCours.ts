export function normaliserRecherche(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr")
    .trim();
}

export const COMPTE_GMAIL_COURS = "coursescalade@caflarochebonneville.fr";

export interface ContactCoursFiltrable {
  nom?: string | null;
  prenom?: string | null;
  cours?: string | null;
  horaire?: string | null;
  encadrants?: string | null;
}

export interface FiltresContactsCours {
  recherche: string;
  cours: string;
  horaires: string[];
  encadrant: string;
}

export interface OptionsContactsCours {
  cours: string[];
  horaires: string[];
  encadrants: string[];
}

type FacetteContactsCours = "cours" | "horaire" | "encadrant";

export function separerEncadrants(value: string | null | undefined): string[] {
  if (!value) return [];

  return [...new Set(
    value
      .split(/\s*(?:,|;|\/|\||\bet\b)\s*/i)
      .map((encadrant) => encadrant.trim())
      .filter(Boolean),
  )];
}

export function normaliserTelephoneWhatsApp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const nettoye = value.trim().replace(/[^\d+]/g, "");
  if (!nettoye) return null;

  let numero: string;
  if (nettoye.startsWith("+")) {
    numero = nettoye.slice(1).replace(/\D/g, "");
  } else if (nettoye.startsWith("00")) {
    numero = nettoye.slice(2).replace(/\D/g, "");
  } else {
    const chiffres = nettoye.replace(/\D/g, "");
    if (chiffres.startsWith("0")) {
      numero = `33${chiffres.slice(1)}`;
    } else if (/^[67]\d{8}$/.test(chiffres)) {
      numero = `33${chiffres}`;
    } else {
      numero = chiffres;
    }
  }

  // Les annuaires français écrivent parfois « +33 (0)6… » : le zéro
  // national doit disparaître dans le format international WhatsApp.
  if (numero.startsWith("330")) numero = `33${numero.slice(3)}`;

  return /^\d{8,15}$/.test(numero) ? numero : null;
}

export function emailsUniques(values: Array<string | null | undefined>): string[] {
  const uniques = new Map<string, string>();

  for (const value of values) {
    const email = normaliserAdresseEmailUnique(value);
    if (!email) continue;
    const cle = email.toLocaleLowerCase("fr");
    if (!uniques.has(cle)) uniques.set(cle, email);
  }

  return [...uniques.values()];
}

export const TAILLE_LOT_EMAILS = 99;
export const SEUIL_COPIE_DIRECTE_EMAILS = 100;

export function doitCopierEmailsParLots(nombreEmails: number): boolean {
  return nombreEmails > SEUIL_COPIE_DIRECTE_EMAILS;
}

export function decouperEmailsEnLots(emails: string[]): string[][] {
  const lots: string[][] = [];

  for (let index = 0; index < emails.length; index += TAILLE_LOT_EMAILS) {
    lots.push(emails.slice(index, index + TAILLE_LOT_EMAILS));
  }

  return lots;
}

export function creerEmpreinteEmails(emails: string[]): string {
  const contenu = emails
    .map((email) => email.toLocaleLowerCase("fr"))
    .join("\n");
  let hash = 2166136261;

  for (let index = 0; index < contenu.length; index += 1) {
    hash ^= contenu.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `v1-${emails.length}-${(hash >>> 0).toString(36)}`;
}

export function normaliserAdresseEmailUnique(
  value: string | null | undefined,
): string | null {
  const brut = value ?? "";
  const contientSeparateurOuControle = [...brut].some((caractere) => {
    const code = caractere.charCodeAt(0);
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      caractere === "," ||
      caractere === ";"
    );
  });
  const email = brut.trim();
  if (!email || email.length > 254 || contientSeparateurOuControle) {
    return null;
  }

  const parties = email.split("@");
  if (parties.length !== 2) return null;
  const [local, domaine] = parties;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  ) {
    return null;
  }

  const labels = domaine.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label),
    )
  ) {
    return null;
  }

  return email;
}

export function filtrerContactsCours<T extends ContactCoursFiltrable>(
  contacts: T[],
  filtres: FiltresContactsCours,
  facetteIgnoree?: FacetteContactsCours,
): T[] {
  const terme = normaliserRecherche(filtres.recherche);

  return contacts.filter((contact) => {
    const nomComplet = normaliserRecherche(
      `${contact.prenom ?? ""} ${contact.nom ?? ""} ${contact.nom ?? ""} ${contact.prenom ?? ""}`,
    );
    const encadrants = separerEncadrants(contact.encadrants);

    return (
      (!terme || nomComplet.includes(terme)) &&
      (facetteIgnoree === "cours" ||
        !filtres.cours ||
        contact.cours?.trim() === filtres.cours) &&
      (facetteIgnoree === "horaire" ||
        filtres.horaires.length === 0 ||
        filtres.horaires.includes(contact.horaire?.trim() ?? "")) &&
      (facetteIgnoree === "encadrant" ||
        !filtres.encadrant ||
        encadrants.includes(filtres.encadrant))
    );
  });
}

export function calculerOptionsContactsCours(
  contacts: ContactCoursFiltrable[],
  filtres: FiltresContactsCours,
): OptionsContactsCours {
  const cours = new Set<string>();
  const horaires = new Set<string>();
  const encadrants = new Set<string>();

  for (const contact of filtrerContactsCours(contacts, filtres, "cours")) {
    if (contact.cours?.trim()) cours.add(contact.cours.trim());
  }
  for (const contact of filtrerContactsCours(contacts, filtres, "horaire")) {
    if (contact.horaire?.trim()) horaires.add(contact.horaire.trim());
  }
  for (const contact of filtrerContactsCours(contacts, filtres, "encadrant")) {
    for (const nom of separerEncadrants(contact.encadrants)) encadrants.add(nom);
  }

  const trier = (values: Set<string>) =>
    [...values].sort((a, b) =>
      a.localeCompare(b, "fr", { sensitivity: "base" }),
    );

  return {
    cours: trier(cours),
    horaires: trier(horaires),
    encadrants: trier(encadrants),
  };
}

export function reconcilierFiltresContactsCours(
  filtres: FiltresContactsCours,
  options: OptionsContactsCours,
): FiltresContactsCours {
  return {
    ...filtres,
    cours:
      !filtres.cours || options.cours.includes(filtres.cours)
        ? filtres.cours
        : "",
    horaires: filtres.horaires.filter(
      (horaire, index) =>
        options.horaires.includes(horaire) &&
        filtres.horaires.indexOf(horaire) === index,
    ),
    encadrant:
      !filtres.encadrant || options.encadrants.includes(filtres.encadrant)
        ? filtres.encadrant
        : "",
  };
}

export function filtresContactsCoursEgaux(
  a: FiltresContactsCours,
  b: FiltresContactsCours,
): boolean {
  return (
    a.recherche === b.recherche &&
    a.cours === b.cours &&
    a.horaires.length === b.horaires.length &&
    a.horaires.every((horaire, index) => horaire === b.horaires[index]) &&
    a.encadrant === b.encadrant
  );
}

export function normaliserHorairesFiltres(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((horaire) => typeof horaire !== "string")) {
    return null;
  }

  return [...new Set(
    value
      .map((horaire) => horaire.trim())
      .filter(Boolean),
  )];
}

export function estAppareilMobileWhatsApp(
  userAgent: string,
  maxTouchPoints: number,
): boolean {
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)
  );
}

export function creerLienWhatsApp(
  telephone: string,
  mobile: boolean,
): string {
  return mobile
    ? `whatsapp://send?phone=${encodeURIComponent(telephone)}`
    : `https://web.whatsapp.com/send?phone=${encodeURIComponent(telephone)}`;
}

export function creerLienGmail({
  destinataire,
  cci = [],
}: {
  destinataire?: string;
  cci?: string[];
}): string {
  const url = new URL("https://mail.google.com/mail/");
  url.searchParams.set("authuser", COMPTE_GMAIL_COURS);
  url.searchParams.set("view", "cm");
  url.searchParams.set("fs", "1");
  if (destinataire) {
    const email = normaliserAdresseEmailUnique(destinataire);
    if (!email) throw new TypeError("Adresse email individuelle invalide.");
    url.searchParams.set("to", email);
  }
  const destinatairesCci = emailsUniques(cci);
  if (destinatairesCci.length > 0) {
    url.searchParams.set("bcc", destinatairesCci.join(","));
  }
  return url.toString();
}
