// Vérification des licences FFCAM des élèves EN COURS (portail staff, tuile
// "licences_cours" — distinct du portail Abonnements qui gère les demandes).
//
// Règle de validité (saison sportive démarrant début septembre) :
//   - horaire === "Liste d'attente" → élève pas en cours, hors périmètre.
//   - licence renseignée → toujours valide.
//   - licence vide → valide UNIQUEMENT en septembre ET si saison_precedente
//     est renseignée (élève déjà en cours l'an dernier, tolérance d'un mois
//     pour re-fournir son numéro). Sinon → non valide.
// abo_eleves_en_cours est régénérée à chaque scrape du site club. Le suivi
// manuel est donc conservé à part, avec une identité métier stable et prudente.

import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { requireTile } from "../access";
import {
  normaliserNomPrenom,
  estSeptembreParis,
  trigrammes,
  similariteTrigrammes,
} from "./lib";
import {
  compterOccurrencesParNom,
  construireIdentiteLicenceCours,
} from "./licencesCoursIdentite";
import { lireElevesEnCoursCompacts } from "./compteurCache";

// Seuil relevé par rapport au défaut pg_trgm (0.3) : à 0.3 la liste remonte
// beaucoup de candidats peu pertinents, peu utiles pour le suivi manuel.
const SEUIL_TRGM = 0.5;
const MAX_CANDIDATS = 5;
// Doit rester aligné avec MAX_ELEVES_SNAPSHOT dans abo/compteur.ts.
const MAX_ELEVES_EN_COURS = 1_000;
const MAX_TRAITEMENTS = 1_000;
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
      email: v.union(v.string(), v.null()),
      emailSource: v.union(v.literal("eleve"), v.literal("gestion"), v.null()),
      traite: v.boolean(),
      traiteAt: v.union(v.string(), v.null()),
      traitementPossible: v.boolean(),
      raison: v.union(
        v.literal("licence_absente_hors_fenetre"),
        v.literal("nouvel_eleve_sans_licence"),
      ),
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

    // IO-BOUNDED: les snapshots externes sont plafonnés par leurs imports
    // (1 000 élèves et 5 000 licences). Les traitements sont purgés au
    // remplacement du snapshot et ne peuvent donc pas dépasser 1 000 lignes.
    const tous = await lireElevesEnCoursCompacts(ctx, MAX_ELEVES_EN_COURS + 1);
    if (tous.length > MAX_ELEVES_EN_COURS) {
      throw new ConvexError({
        code: "54000",
        message: `Le snapshot élèves dépasse la limite de ${MAX_ELEVES_EN_COURS} lignes.`,
      });
    }
    const enCours = tous.filter((e) => e.horaire !== "Liste d'attente");

    const invalides = enCours.filter((e) => !licenceValide(e, now));
    if (invalides.length === 0) return { total: 0, eleves: [] };

    const traitements = await ctx.db
      .query("abo_licences_cours_traitements")
      .take(MAX_TRAITEMENTS + 1);
    if (traitements.length > MAX_TRAITEMENTS) {
      throw new ConvexError({
        code: "54000",
        message: `Le suivi des traitements dépasse la limite de ${MAX_TRAITEMENTS} lignes.`,
      });
    }
    const traitementsParCle = new Map(
      traitements.map((traitement) => [traitement.cle_identite, traitement]),
    );
    const occurrencesParNom = compterOccurrencesParNom(tous);
    const invalidesAvecTraitement = invalides.map((eleve) => {
      const identite = construireIdentiteLicenceCours(eleve, occurrencesParNom);
      const traitement = identite ? traitementsParCle.get(identite.cle) : undefined;
      return { eleve, identite, traitement };
    });

    const eleves = invalidesAvecTraitement.map(({ eleve: e, identite, traitement }) => {
      const raison: Raison =
        estSeptembreParis(now) && (e.saison_precedente ?? "").trim() === ""
          ? "nouvel_eleve_sans_licence"
          : "licence_absente_hors_fenetre";

      return {
        eleve_id: e.source_eleve_id,
        nom: e.nom ?? null,
        prenom: e.prenom ?? null,
        cours: e.cours ?? null,
        horaire: e.horaire ?? null,
        ...emailEffectif(e),
        traite: traitement !== undefined,
        traiteAt: traitement?.traite_at ?? null,
        traitementPossible: identite !== null,
        raison,
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

// Cette query coûteuse ne lit volontairement PAS la table des traitements.
// Son résultat reste donc en cache quand le staff coche/décoche une personne :
// le scan borné de l'annuaire n'est refait qu'après changement du snapshot des
// élèves, de l'annuaire ou du jour métier.
export const getCandidatsLicences = authenticatedQuery({
  args: { maintenantJour: v.string() },
  returns: v.array(v.object({
    eleveId: v.id("abo_eleves_en_cours"),
    candidats: v.array(v.object({
      licence: v.string(),
      nom: v.union(v.string(), v.null()),
      prenom: v.union(v.string(), v.null()),
      score: v.number(),
    })),
  })),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "licences_cours");
    const now = Date.now();
    if (args.maintenantJour !== cleJourParis(now)) {
      throw new ConvexError({
        code: "40001",
        message: "La journée indiquée ne correspond pas au calendrier du serveur.",
      });
    }

    // IO-BOUNDED: rapprochement de deux snapshots complets plafonnés à
    // 1 000 élèves et 5 000 licences. La query est isolée pour préserver son
    // cache lors des écritures dans la table de suivi manuel.
    const tous = await lireElevesEnCoursCompacts(ctx, MAX_ELEVES_EN_COURS + 1);
    if (tous.length > MAX_ELEVES_EN_COURS) {
      throw new ConvexError({
        code: "54000",
        message: `Le snapshot élèves dépasse la limite de ${MAX_ELEVES_EN_COURS} lignes.`,
      });
    }
    const invalides = tous.filter(
      (eleve) => eleve.horaire !== "Liste d'attente" && !licenceValide(eleve, now),
    );
    if (invalides.length === 0) return [];

    const annuaire = await ctx.db.query("abo_licences").take(MAX_LICENCES + 1);
    if (annuaire.length > MAX_LICENCES) {
      throw new ConvexError({
        code: "54000",
        message: `L'annuaire des licences dépasse la limite de ${MAX_LICENCES} lignes.`,
      });
    }

    const annuaireTg = annuaire.map((licence) => ({
      licence,
      trigrammes: trigrammes(licence.nom_prenom_normalise),
    }));
    return invalides.map((eleve) => {
        const directs = trigrammes(eleve.nom_prenom_normalise);
        const inverses = trigrammes(normaliserNomPrenom(eleve.prenom, eleve.nom));
        const candidats = annuaireTg
          .map(({ licence, trigrammes: candidatTg }) => ({
            licence,
            score: Math.max(
              similariteTrigrammes(directs, candidatTg),
              similariteTrigrammes(inverses, candidatTg),
            ),
          }))
          .filter(({ score }) => score >= SEUIL_TRGM)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_CANDIDATS)
          .map(({ licence, score }) => ({
            licence: licence.licence,
            nom: licence.nom ?? null,
            prenom: licence.prenom ?? null,
            score,
          }));
        return { eleveId: eleve.source_eleve_id, candidats };
    });
  },
});

export const definirTraite = authenticatedMutation({
  args: {
    eleveId: v.id("abo_eleves_en_cours"),
    traite: v.boolean(),
  },
  returns: v.object({
    traite: v.boolean(),
    traiteAt: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "licences_cours");

    const eleve = await ctx.db.get("abo_eleves_en_cours", args.eleveId);
    if (!eleve) {
      throw new ConvexError({ code: "02000", message: "Cet élève n'est plus dans le snapshot courant." });
    }
    if (licenceValide(eleve, Date.now())) {
      throw new ConvexError({
        code: "22023",
        message: "Cet élève possède désormais une licence : la synchronisation est prioritaire.",
      });
    }

    let identite = construireIdentiteLicenceCours(eleve, new Map());
    if (!identite) {
      const memeNom = await ctx.db
        .query("abo_eleves_en_cours")
        .withIndex("by_nom_prenom_normalise", (q) =>
          q.eq("nom_prenom_normalise", eleve.nom_prenom_normalise),
        )
        .take(2);
      identite = construireIdentiteLicenceCours(
        eleve,
        new Map([[eleve.nom_prenom_normalise, memeNom.length]]),
      );
    }
    if (!identite) {
      throw new ConvexError({
        code: "21000",
        message: "Impossible de distinguer cette personne avec certitude (homonymie ou identité incomplète).",
      });
    }

    const existant = await ctx.db
      .query("abo_licences_cours_traitements")
      .withIndex("by_cle_identite", (q) => q.eq("cle_identite", identite.cle))
      .unique();
    if (!args.traite) {
      if (existant) await ctx.db.delete(existant._id);
      return { traite: false, traiteAt: null };
    }
    if (existant) return { traite: true, traiteAt: existant.traite_at };

    const traiteAt = new Date().toISOString();
    await ctx.db.insert("abo_licences_cours_traitements", {
      cle_identite: identite.cle,
      traite_at: traiteAt,
      traite_par: ctx.userId,
    });
    return { traite: true, traiteAt };
  },
});
