// Vérification des licences FFCAM des élèves EN COURS (portail staff, tuile
// "licences_cours" — distinct du portail Abonnements qui gère les demandes).
//
// Règle de validité (saison sportive démarrant début septembre) :
//   - horaire === "Liste d'attente" → élève pas en cours, hors périmètre.
//   - licence renseignée → toujours valide.
//   - licence vide → valide UNIQUEMENT en septembre ET si saison_precedente
//     est renseignée (élève déjà en cours l'an dernier, tolérance d'un mois
//     pour re-fournir son numéro). Sinon → non valide.
// Lecture seule : abo_eleves_en_cours est régénérée à chaque scrape du site
// club, ce n'est pas la table d'identité canonique — aucune résolution n'y
// est persistée ici (à la différence de abo/licences.ts sur abo_personnes).

import { ConvexError, v } from "convex/values";
import { authenticatedQuery } from "../customFunctions";
import { requireTile } from "../access";
import {
  normaliserNomPrenom,
  estSeptembreParis,
  trigrammes,
  similariteTrigrammes,
} from "./lib";

// Seuil relevé par rapport au défaut pg_trgm (0.3) : à 0.3 la liste remonte
// beaucoup de candidats peu pertinents, peu utiles pour le suivi manuel.
const SEUIL_TRGM = 0.5;
const MAX_CANDIDATS = 5;
const MAX_ELEVES_EN_COURS = 500;
// L'annuaire FFCAM du club dépasse 2 000 fiches ; cette même borne est utilisée
// pour l'import et la purge du snapshot dans `abo/licences.ts`.
const MAX_LICENCES = 5_000;

const JOURS_SEMAINE = [
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
  "dimanche",
] as const;

function emailValide(value: string | undefined): string | null {
  const email = value?.trim() ?? "";
  const contientSeparateurOuControle = [...email].some((caractere) => {
    const code = caractere.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || caractere === "," || caractere === ";";
  });
  if (!email || email.length > 254 || contientSeparateurOuControle) return null;
  const [local, domaine, ...reste] = email.split("@");
  if (
    reste.length > 0 || !local || !domaine || local.length > 64 ||
    local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    domaine.split(".").length < 2 ||
    domaine.split(".").some((label) => !label || label.length > 63 || !/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label))
  ) return null;
  return email;
}

function emailEffectif(eleve: { email_eleve?: string; email_gestion?: string }) {
  const emailEleve = emailValide(eleve.email_eleve);
  if (emailEleve) return { email: emailEleve, emailSource: "eleve" as const };
  const emailGestion = emailValide(eleve.email_gestion);
  if (emailGestion) return { email: emailGestion, emailSource: "gestion" as const };
  return { email: null, emailSource: null };
}

function jourDansHoraire(horaire: string | null): number | null {
  const texte = (horaire ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr");
  const index = JOURS_SEMAINE.findIndex((jour) => texte.includes(jour));
  return index === -1 ? null : index;
}

function jourCourantParis(nowMs: number): number {
  const nomJour = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
  }).format(new Date(nowMs));
  return JOURS_SEMAINE.indexOf(nomJour as (typeof JOURS_SEMAINE)[number]);
}

function cleJourParis(nowMs: number): string {
  const parties = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const valeurs = Object.fromEntries(
    parties
      .filter((partie) => partie.type !== "literal")
      .map((partie) => [partie.type, partie.value]),
  );
  return `${valeurs.year}-${valeurs.month}-${valeurs.day}`;
}

type Raison = "licence_absente_hors_fenetre" | "nouvel_eleve_sans_licence";

function licenceValide(
  eleve: { licence?: string; saison_precedente?: string },
  nowMs: number,
): boolean {
  if ((eleve.licence ?? "").trim() !== "") return true;
  const saisonPrecedente = (eleve.saison_precedente ?? "").trim();
  return estSeptembreParis(nowMs) && saisonPrecedente !== "";
}

export const getElevesLicenceInvalide = authenticatedQuery({
  args: { maintenantJour: v.string() },
  returns: v.object({
    total: v.number(),
    eleves: v.array(v.object({
      eleve_id: v.id("abo_eleves_en_cours"),
      nom: v.union(v.string(), v.null()),
      prenom: v.union(v.string(), v.null()),
      cours: v.union(v.string(), v.null()),
      horaire: v.union(v.string(), v.null()),
      licence: v.union(v.string(), v.null()),
      saison_precedente: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
      emailSource: v.union(v.literal("eleve"), v.literal("gestion"), v.null()),
      raison: v.union(
        v.literal("licence_absente_hors_fenetre"),
        v.literal("nouvel_eleve_sans_licence"),
      ),
      candidats: v.array(v.object({
        licence: v.string(),
        nom: v.union(v.string(), v.null()),
        prenom: v.union(v.string(), v.null()),
        score: v.number(),
      })),
    })),
  }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "licences_cours");

    // La clé est stable pendant la journée tout en provoquant le recalcul à
    // minuit. Le serveur la compare à son propre calendrier pour empêcher un
    // client de simuler une autre période de tolérance.
    const now = Date.now();
    if (args.maintenantJour !== cleJourParis(now)) {
      throw new ConvexError({
        code: "40001",
        message: "La journée indiquée ne correspond pas au calendrier du serveur.",
      });
    }

    // IO-BOUNDED: les deux snapshots externes sont plafonnés par leurs imports
    // (500 élèves et 5 000 licences) ; le rapprochement trigramme les parcourt.
    const tous = await ctx.db.query("abo_eleves_en_cours").take(MAX_ELEVES_EN_COURS + 1);
    if (tous.length > MAX_ELEVES_EN_COURS) {
      throw new ConvexError({
        code: "54000",
        message: `Le snapshot élèves dépasse la limite de ${MAX_ELEVES_EN_COURS} lignes.`,
      });
    }
    const enCours = tous.filter((e) => e.horaire !== "Liste d'attente");

    const invalides = enCours.filter((e) => !licenceValide(e, now));
    if (invalides.length === 0) return { total: 0, eleves: [] };

    const annuaire = await ctx.db.query("abo_licences").take(MAX_LICENCES + 1);
    if (annuaire.length > MAX_LICENCES) {
      throw new ConvexError({
        code: "54000",
        message: `L'annuaire des licences dépasse la limite de ${MAX_LICENCES} lignes.`,
      });
    }
    // Trigrammes de l'annuaire pré-calculés une seule fois (pas à chaque élève
    // invalide comparé) : évite le O(n_invalides × n_annuaire) recalculs qui
    // faisait dépasser le budget d'exécution d'une query (1s).
    const annuaireTg = annuaire.map((l) => ({
      l,
      tg: trigrammes(l.nom_prenom_normalise),
    }));

    const eleves = invalides.map((e) => {
      const raison: Raison =
        estSeptembreParis(now) && (e.saison_precedente ?? "").trim() === ""
          ? "nouvel_eleve_sans_licence"
          : "licence_absente_hors_fenetre";

      let candidats: Array<{
        licence: string;
        nom: string | null;
        prenom: string | null;
        score: number;
      }> = [];

      if ((e.licence ?? "").trim() === "") {
        const tgDirecte = trigrammes(e.nom_prenom_normalise);
        const tgInverse = trigrammes(normaliserNomPrenom(e.prenom, e.nom));
        candidats = annuaireTg
          .map(({ l, tg }) => ({
            l,
            score: Math.max(
              similariteTrigrammes(tgDirecte, tg),
              similariteTrigrammes(tgInverse, tg),
            ),
          }))
          .filter((x) => x.score >= SEUIL_TRGM)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_CANDIDATS)
          .map((x) => ({
            licence: x.l.licence,
            nom: x.l.nom ?? null,
            prenom: x.l.prenom ?? null,
            score: x.score,
          }));
      }

      return {
        eleve_id: e._id,
        nom: e.nom ?? null,
        prenom: e.prenom ?? null,
        cours: e.cours ?? null,
        horaire: e.horaire ?? null,
        licence: e.licence ?? null,
        saison_precedente: e.saison_precedente ?? null,
        ...emailEffectif(e),
        raison,
        candidats,
      };
    });

    const jourCourant = jourCourantParis(now);
    eleves.sort((a, b) => {
      const prioriteA = a.raison === "licence_absente_hors_fenetre" ? 0 : 1;
      const prioriteB = b.raison === "licence_absente_hors_fenetre" ? 0 : 1;
      if (prioriteA !== prioriteB) return prioriteA - prioriteB;

      const jourA = jourDansHoraire(a.horaire);
      const jourB = jourDansHoraire(b.horaire);
      const positionA = jourA === null ? 7 : (jourA - jourCourant + 7) % 7;
      const positionB = jourB === null ? 7 : (jourB - jourCourant + 7) % 7;
      if (positionA !== positionB) return positionA - positionB;

      const cours = (a.cours ?? "").localeCompare(b.cours ?? "", "fr", { sensitivity: "base" });
      if (cours !== 0) return cours;
      return `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, "fr");
    });

    return { total: eleves.length, eleves };
  },
});
