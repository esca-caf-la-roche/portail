// Compteur des places / anomalies / élèves en cours (wave-aware). Portage de :
//   - v_legit_scrap.sql   → legitScrap (A1 N-1 ∨ A2 élèves ∨ A3 validées)
//   - compteur_wave.sql    → calculerCompteur (occupe = legit + validées hors scrap)
//   - v_anomalies.sql      → anomalies (scrap − legit, avec motif)
//   - compteur_public_wave.sql → compteurPublic (agrégat ANONYME, iframe club)
//   - eleves_en_cours.sql / import-eleves.js → getElevesEnCours + upsert
//
// Les vues Postgres (security_invoker) → queries Convex recalculant la même
// logique d'ensembles. Toutes les lectures sont bornées par la taille réelle du
// club (scrap ≈ places, annuaire/personnes = volume d'une saison).

import { v, ConvexError } from "convex/values";
import { query, internalMutation } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { authenticatedQuery, authenticatedMutation } from "../customFunctions";
import { requireAboAdmin, requireAboConfigurationManager } from "./auth";
import { vagueCourante, getConfigValeur } from "./config";
import { canoniserLicence, normaliserNomPrenom } from "./lib";
import { champsModifies } from "../dbUtils";
import {
  abonnementEstValide,
  normaliserStatutAbonnement,
  statutAbonnementNormaliseValidator,
} from "./statutAbonnement";
import {
  compterOccurrencesParNom,
  construireIdentiteLicenceCours,
} from "./licencesCoursIdentite";
import {
  CLE_COMPTEUR_A_RECALCULER,
  programmerRafraichissementCompteurPublic,
} from "./compteurCache";

export { invaliderCompteurPublic, programmerRafraichissementCompteurPublic } from "./compteurCache";

const PLACES_MAX_DEFAUT = 350;
const MAX_ELEVES_SNAPSHOT = 1_000;
const MAX_LIGNES_COMPTEUR = 2_000;

// ── Cœur du compteur : ensembles legit / validées / anomalies ────────
// Un seul balayage borné des tables, réutilisé par vCompteur, vAnomalies et
// compteurPublic. Fidèle à l'algèbre d'ensembles des vues SQL wave-aware.
interface CompteurData {
  abonnes_scrap: number;
  abonnements_site_valides: number;
  abonnements_site_non_valides_a_suivre: number;
  legit_scrap: number;
  demandes_validees: number;
  demandes_liste_attente: number;
  demandes_refusees: number;
  demandes_a_traiter: number;
  validees_hors_legit: number;
  bloquees: number;
  anomalies: number;
  total_affiche: number;
  // Occupation transactionnelle pour le plafond de validation : les anomalies
  // ne l'occupent pas automatiquement.
  occupe: number;
  elevesLic: Set<string>;
  classifications: Array<{
    scrap: Doc<"abo_abonnes_scrap">;
    categorie: "validee" | "non_validee" | "bloquee" | "inconnue";
    statutSite: "oui" | "non" | "bloque" | "inconnu";
    n1: "oui" | "non" | "ambigu";
    demande: "absente" | "ambigu" | "en_attente" | "validee" | "liste_attente" | "refusee";
    statutDossier: Doc<"abo_dossiers">["statut_dossier"] | "inconnu";
    rapprochement: "licence" | "nom_prenom_unique" | "aucun" | "ambigu";
    personneId: Id<"abo_personnes"> | null;
    dossierId: Id<"abo_dossiers"> | null;
  }>;
}

const codeAnomalieValidator = v.union(
  v.literal("statut_inconnu"),
  v.literal("n1_ambigu"),
  v.literal("absence_demande"),
  v.literal("demande_non_validee"),
);

type CodeAnomalie =
  | "statut_inconnu"
  | "n1_ambigu"
  | "absence_demande"
  | "demande_non_validee";

type Classification = CompteurData["classifications"][number];

function codeAnomalieDe(ligne: Classification): CodeAnomalie {
  if (ligne.categorie === "inconnue") return "statut_inconnu";
  if (ligne.n1 === "ambigu") return "n1_ambigu";
  if (ligne.demande === "absente") return "absence_demande";
  return "demande_non_validee";
}

function estAnomalie(ligne: Classification): boolean {
  return ligne.categorie === "non_validee" || ligne.categorie === "inconnue";
}

function cleAcquittement(licence: string, code: CodeAnomalie): string {
  return `${licence}:${code}`;
}

// Les mutations de validation peuvent fournir une décision projetée pour une ou
// plusieurs personnes. La projection conserve ainsi exactement la même
// algèbre (scrap légitime + dédoublonnage) que le compteur affiché.
export async function calculerCompteur(
  ctx: QueryCtx | MutationCtx,
  decisionsProjetees: ReadonlyMap<
    Id<"abo_personnes">,
    Doc<"abo_personnes">["etape_validation"]
  > | undefined,
  inclureStatutsDossier = false,
): Promise<CompteurData> {
  const [scrap, archive, eleves, personnes] = await Promise.all([
    ctx.db.query("abo_abonnes_scrap").take(MAX_LIGNES_COMPTEUR + 1),
    ctx.db.query("abo_abonnes_archive").take(MAX_LIGNES_COMPTEUR + 1),
    ctx.db.query("abo_eleves_en_cours").take(MAX_LIGNES_COMPTEUR + 1),
    ctx.db.query("abo_personnes").take(MAX_LIGNES_COMPTEUR + 1),
  ]);
  if ([scrap, archive, eleves, personnes].some((lignes) => lignes.length > MAX_LIGNES_COMPTEUR)) {
    throw new ConvexError({
      code: "ABO_COMPTEUR_VOLUME",
      message: `Le compteur dépasse sa limite de sécurité de ${MAX_LIGNES_COMPTEUR} lignes par source.`,
    });
  }

  // A1 : abonnés validés N-1 (droit acquis, toutes vagues) — par licence.
  const archiveNomOccurrences = new Map<string, number>();
  for (const a of archive) {
    if (!abonnementEstValide(a.abonnement_valide)) continue;
    archiveNomOccurrences.set(
      a.nom_prenom_normalise,
      (archiveNomOccurrences.get(a.nom_prenom_normalise) ?? 0) + 1,
    );
  }
  // A2 : élèves en cours d'escalade (vague ≥ 2) — par licence.
  const elevesLic = new Set<string>();
  for (const e of eleves) if (e.licence) elevesLic.add(e.licence);

  // A3 : demandes validées chez nous (vague ≥ 2) — licence sinon nom+prénom.
  const decisionDe = (p: (typeof personnes)[number]) =>
    decisionsProjetees?.get(p._id) ?? p.etape_validation;
  const valides = personnes.filter((p) => decisionDe(p) === "validee");
  const personnesParLicence = new Map<string, (typeof personnes)[number][]>();
  const personnesParNom = new Map<string, (typeof personnes)[number][]>();
  const scrapParNom = new Map<string, number>();
  for (const personne of personnes) {
    if (personne.licence) {
      const liste = personnesParLicence.get(personne.licence) ?? [];
      liste.push(personne);
      personnesParLicence.set(personne.licence, liste);
    }
    const liste = personnesParNom.get(personne.nom_prenom_normalise) ?? [];
    liste.push(personne);
    personnesParNom.set(personne.nom_prenom_normalise, liste);
  }
  for (const ligne of scrap) {
    scrapParNom.set(
      ligne.nom_prenom_normalise,
      (scrapParNom.get(ligne.nom_prenom_normalise) ?? 0) + 1,
    );
  }
  const classifications = [] as CompteurData["classifications"];
  for (const ligne of scrap) {
    // Les anciennes lignes « false » ne permettent pas de savoir si le site
    // disait Non ou Bloqué. Elles sont donc exclues jusqu'à une synchronisation
    // complète plutôt que comptées à tort.
    const statutSite = normaliserStatutAbonnement(ligne.abonnement_valide);
    const occurrencesN1 = archiveNomOccurrences.get(ligne.nom_prenom_normalise) ?? 0;
    const n1: "oui" | "non" | "ambigu" = occurrencesN1 > 1
      ? "ambigu"
      : occurrencesN1 === 1
        ? "oui"
        : "non";
    let candidats = ligne.licence ? personnesParLicence.get(ligne.licence) ?? [] : [];
    let rapprochement: "licence" | "nom_prenom_unique" | "aucun" | "ambigu" = candidats.length === 1 ? "licence" : candidats.length > 1 ? "ambigu" : "aucun";
    if (candidats.length === 0) {
      const parNom = personnesParNom.get(ligne.nom_prenom_normalise) ?? [];
      if (parNom.length === 1 && (scrapParNom.get(ligne.nom_prenom_normalise) ?? 0) === 1) {
        candidats = parNom;
        rapprochement = "nom_prenom_unique";
      } else if (parNom.length > 0) rapprochement = "ambigu";
    }
    const personne = candidats.length === 1 ? candidats[0] : null;
    const demande: CompteurData["classifications"][number]["demande"] = !personne
      ? rapprochement === "ambigu" ? "ambigu" : "absente"
      : decisionDe(personne);
    const categorie: CompteurData["classifications"][number]["categorie"] =
      statutSite === "inconnu"
        ? "inconnue"
        : statutSite === "bloque"
          ? "bloquee"
          : n1 === "oui" || demande === "validee"
            ? "validee"
            : "non_validee";
    classifications.push({
      scrap: ligne,
      categorie,
      statutSite,
      n1,
      demande,
      statutDossier: "inconnu",
      rapprochement,
      personneId: personne?._id ?? null,
      dossierId: personne?.dossier_id ?? null,
    });
  }

  if (inclureStatutsDossier) {
    const dossierIds = [
      ...new Set(
        classifications
          .filter(
            (ligne) =>
              (ligne.categorie === "non_validee" || ligne.categorie === "inconnue") &&
              ligne.dossierId !== null,
          )
          .map((ligne) => ligne.dossierId as Id<"abo_dossiers">),
      ),
    ];
    // Au plus une lecture par dossier anormal, en parallèle. La cardinalité est
    // bornée par MAX_LIGNES_COMPTEUR, déjà contrôlée sur abo_personnes.
    const dossiers = await Promise.all(dossierIds.map((id) => ctx.db.get(id)));
    const statutsDossiers = new Map(
      dossierIds.map((id, index) => [
        id,
        dossiers[index]?.statut_dossier ?? "inconnu",
      ] as const),
    );
    for (const ligne of classifications) {
      if (ligne.dossierId) {
        ligne.statutDossier = statutsDossiers.get(ligne.dossierId) ?? "inconnu";
      }
    }
  }
  // Une demande validée est dédoublonnée dès qu'elle est déjà reliée de façon
  // certaine à une inscription du site. Le compteur public inclut en effet les
  // inscriptions validées et non validées, à l'exception des bloquées.
  const personnesRelieesAuScrap = new Set(
    classifications
      .filter((ligne) => ligne.personneId !== null)
      .map((ligne) => ligne.personneId as Id<"abo_personnes">),
  );
  const validees_hors_legit = valides.filter(
    (p) => !personnesRelieesAuScrap.has(p._id),
  ).length;

  // Le total du site est la lecture brute de son champ : Oui + Non.
  // Les règles métier ne modifient pas ce décompte.
  const siteCompte = classifications.filter(
    (ligne) => ligne.statutSite === "oui" || ligne.statutSite === "non",
  );
  const legit_scrap = classifications.filter((ligne) => ligne.categorie === "validee").length;
  const bloqueesSite = classifications.filter((ligne) => ligne.statutSite === "bloque").length;
  const nonValideesSite = siteCompte.filter((ligne) => ligne.statutSite === "non").length;
  const valideesSite = siteCompte.filter((ligne) => ligne.statutSite === "oui").length;
  return {
    abonnes_scrap: scrap.length,
    abonnements_site_valides: valideesSite,
    abonnements_site_non_valides_a_suivre: nonValideesSite,
    legit_scrap,
    demandes_validees: valides.length,
    demandes_liste_attente: personnes.filter((p) => decisionDe(p) === "liste_attente").length,
    demandes_refusees: personnes.filter((p) => decisionDe(p) === "refusee").length,
    demandes_a_traiter: personnes.filter((p) => decisionDe(p) === "en_attente").length,
    validees_hors_legit,
    // « Bloquées » correspond exclusivement à la valeur Bloqué du site.
    bloquees: bloqueesSite,
    anomalies: classifications.filter(
      (ligne) => ligne.categorie === "non_validee" || ligne.categorie === "inconnue",
    ).length,
    total_affiche: siteCompte.length + validees_hors_legit,
    occupe: legit_scrap + validees_hors_legit,
    elevesLic,
    classifications,
  };
}

// Plafond de places (abo_app_config.places_max), défaut 350.
export async function lirePlacesMax(ctx: QueryCtx | MutationCtx): Promise<number> {
  const brut = await getConfigValeur(ctx, "places_max");
  const n = brut != null ? parseInt(brut, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : PLACES_MAX_DEFAUT;
}

const compteurDetailValidator = v.object({
  abonnes_scrap: v.number(),
  abonnements_site_valides: v.number(),
  abonnements_site_non_valides_a_suivre: v.number(),
  legit_scrap: v.number(),
  demandes_validees: v.number(),
  demandes_liste_attente: v.number(),
  demandes_refusees: v.number(),
  demandes_a_traiter: v.number(),
  validees_hors_legit: v.number(),
  bloquees: v.number(),
  anomalies: v.number(),
  anomalies_brutes: v.number(),
  acquittees: v.number(),
  total_affiche: v.number(),
  occupe: v.number(),
  places_max: v.number(),
});

const compteurPublicValidator = v.object({
  occupe: v.number(),
  places_max: v.number(),
  places_restantes: v.number(),
  vague: v.number(),
});

function cacheCompteurComplet(
  cache: Doc<"abo_compteur_public_cache"> | null,
): cache is Doc<"abo_compteur_public_cache"> & CompteurData & {
  anomalies_brutes: number;
  acquittees: number;
  places_max: number;
  occupe_transactionnel: number;
} {
  return cache !== null && [
    cache.abonnes_scrap,
    cache.abonnements_site_valides,
    cache.abonnements_site_non_valides_a_suivre,
    cache.legit_scrap,
    cache.demandes_validees,
    cache.demandes_liste_attente,
    cache.demandes_refusees,
    cache.demandes_a_traiter,
    cache.validees_hors_legit,
    cache.bloquees,
    cache.anomalies,
    cache.anomalies_brutes,
    cache.acquittees,
    cache.total_affiche,
    cache.occupe_transactionnel,
  ].every((valeur) => typeof valeur === "number");
}

async function lireAcquittements(ctx: QueryCtx | MutationCtx) {
  const acquittements = await ctx.db
    .query("abo_anomalies_acquittements")
    .take(MAX_LIGNES_COMPTEUR + 1);
  if (acquittements.length > MAX_LIGNES_COMPTEUR) {
    throw new ConvexError({
      code: "ABO_ACQUITTEMENTS_VOLUME",
      message: `Les acquittements dépassent la limite de sécurité de ${MAX_LIGNES_COMPTEUR} lignes.`,
    });
  }
  return acquittements;
}

function construireAnomalies(
  c: CompteurData,
  acquittements: Awaited<ReturnType<typeof lireAcquittements>>,
) {
  const acquittementParCle = new Map(
    acquittements.map((a) => [cleAcquittement(a.licence, a.code_anomalie), a] as const),
  );
  return c.classifications
    .filter(estAnomalie)
    .map((ligne) => {
      const { scrap, categorie, statutSite, n1, demande, statutDossier, rapprochement } = ligne;
      const code_anomalie = codeAnomalieDe(ligne);
      const licence = canoniserLicence(scrap.licence);
      const acquittement = licence
        ? acquittementParCle.get(cleAcquittement(licence, code_anomalie)) ?? null
        : null;
      return {
        id: scrap._id,
        licence: scrap.licence ?? null,
        nom: scrap.nom ?? null,
        prenom: scrap.prenom ?? null,
        nom_prenom_normalise: scrap.nom_prenom_normalise,
        abonnement_valide: statutSite,
        code_anomalie,
        peutEtreAcquittee: licence !== null,
        statut: acquittement ? "acquittee" as const : "a_traiter" as const,
        acquittement: acquittement ? {
          id: acquittement._id,
          justification: acquittement.justification,
          acquittee_le: acquittement.acquittee_le,
        } : null,
        type: categorie === "inconnue" ? "inconnue" as const : "non_validee" as const,
        controles: {
          abonneN1: n1 === "oui",
          abonneN1Ambigu: n1 === "ambigu",
          eleveEnCours: licence ? c.elevesLic.has(licence) : false,
          demandeValidee: demande === "validee",
          statutDossier,
          rapprochement,
        },
        raison: categorie === "inconnue"
          ? "Statut du site inconnu : cette ancienne valeur ne permet pas de distinguer Non de Bloqué. Synchronisez à nouveau le site."
          : n1 === "ambigu"
            ? "Correspondance N-1 ambiguë : plusieurs archives validées portent ce nom et prénom. Vérifiez manuellement avant décision."
            : demande === "absente"
              ? "Règle 1 non respectée : la personne n'était pas abonnée l'année dernière et aucune demande n'a été déposée sur le portail."
              : "Règle 2 non respectée : la personne n'était pas abonnée l'année dernière et la demande portail n'est pas validée.",
      };
    })
    .sort((a, b) => a.nom_prenom_normalise.localeCompare(b.nom_prenom_normalise, "fr"));
}

// ── vCompteur : compteur détaillé (admin) ────────────────────────────
export const vCompteur = authenticatedQuery({
  args: {},
  returns: compteurDetailValidator,
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const cache = await ctx.db.query("abo_compteur_public_cache")
      .withIndex("by_cle", (q) => q.eq("cle", "courant")).first();
    if (cacheCompteurComplet(cache)) {
      return {
        abonnes_scrap: cache.abonnes_scrap,
        abonnements_site_valides: cache.abonnements_site_valides,
        abonnements_site_non_valides_a_suivre: cache.abonnements_site_non_valides_a_suivre,
        legit_scrap: cache.legit_scrap,
        demandes_validees: cache.demandes_validees,
        demandes_liste_attente: cache.demandes_liste_attente,
        demandes_refusees: cache.demandes_refusees,
        demandes_a_traiter: cache.demandes_a_traiter,
        validees_hors_legit: cache.validees_hors_legit,
        bloquees: cache.bloquees,
        anomalies: cache.anomalies,
        anomalies_brutes: cache.anomalies_brutes,
        acquittees: cache.acquittees,
        total_affiche: cache.total_affiche,
        occupe: cache.occupe_transactionnel,
        places_max: cache.places_max,
      };
    }
    // Rollout : l'ancien singleton PROD ne porte pas encore le détail.
    const [c, acquittements] = await Promise.all([
      calculerCompteur(ctx, undefined), lireAcquittements(ctx),
    ]);
    const anomaliesAcquittees = construireAnomalies(c, acquittements)
      .filter((ligne) => ligne.statut === "acquittee").length;
    const places_max = await lirePlacesMax(ctx);
    return {
      abonnes_scrap: c.abonnes_scrap,
      abonnements_site_valides: c.abonnements_site_valides,
      abonnements_site_non_valides_a_suivre: c.abonnements_site_non_valides_a_suivre,
      legit_scrap: c.legit_scrap,
      demandes_validees: c.demandes_validees,
      demandes_liste_attente: c.demandes_liste_attente,
      demandes_refusees: c.demandes_refusees,
      demandes_a_traiter: c.demandes_a_traiter,
      validees_hors_legit: c.validees_hors_legit,
      bloquees: c.bloquees,
      anomalies: c.anomalies - anomaliesAcquittees,
      anomalies_brutes: c.anomalies,
      acquittees: anomaliesAcquittees,
      total_affiche: c.total_affiche,
      occupe: c.occupe,
      places_max,
    };
  },
});

// ── vAnomalies : lignes du scrap non légitimes + motif (admin) ───────
export const vAnomalies = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    id: v.id("abo_abonnes_scrap"),
    licence: v.union(v.string(), v.null()),
    nom: v.union(v.string(), v.null()),
    prenom: v.union(v.string(), v.null()),
    nom_prenom_normalise: v.string(),
    abonnement_valide: statutAbonnementNormaliseValidator,
    code_anomalie: codeAnomalieValidator,
    peutEtreAcquittee: v.boolean(),
    statut: v.union(v.literal("a_traiter"), v.literal("acquittee")),
    acquittement: v.union(v.null(), v.object({
      id: v.id("abo_anomalies_acquittements"),
      justification: v.string(),
      acquittee_le: v.string(),
    })),
    type: v.union(v.literal("non_validee"), v.literal("inconnue")),
    controles: v.object({
      abonneN1: v.boolean(),
      abonneN1Ambigu: v.boolean(),
      eleveEnCours: v.boolean(),
      demandeValidee: v.boolean(),
      statutDossier: v.union(
        v.literal("nouvelle_demande"),
        v.literal("complete"),
        v.literal("validee"),
        v.literal("liste_attente"),
        v.literal("refusee"),
        v.literal("inconnu"),
      ),
      rapprochement: v.union(
        v.literal("licence"),
        v.literal("nom_prenom_unique"),
        v.literal("aucun"),
        v.literal("ambigu"),
      ),
    }),
    raison: v.string(),
  })),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const cacheCompteur = await ctx.db.query("abo_compteur_public_cache")
      .withIndex("by_cle", (q) => q.eq("cle", "courant")).first();
    if (cacheCompteurComplet(cacheCompteur)) {
      const lignes = await ctx.db.query("abo_compteur_anomalies_cache")
        .take(MAX_LIGNES_COMPTEUR + 1);
      if (lignes.length > MAX_LIGNES_COMPTEUR) {
        throw new ConvexError({ code: "ABO_ANOMALIES_VOLUME", message: "Le cache des anomalies dépasse sa limite de sécurité." });
      }
      return lignes.map((ligne) => ({
        id: ligne.scrap_id,
        licence: ligne.licence ?? null,
        nom: ligne.nom ?? null,
        prenom: ligne.prenom ?? null,
        nom_prenom_normalise: ligne.nom_prenom_normalise,
        abonnement_valide: ligne.abonnement_valide,
        code_anomalie: ligne.code_anomalie,
        peutEtreAcquittee: ligne.peut_etre_acquittee,
        statut: ligne.statut,
        acquittement: ligne.acquittement_id ? {
          id: ligne.acquittement_id,
          justification: ligne.acquittement_justification ?? "",
          acquittee_le: ligne.acquittement_le ?? "",
        } : null,
        type: ligne.type,
        controles: {
          abonneN1: ligne.abonne_n1,
          abonneN1Ambigu: ligne.abonne_n1_ambigu,
          eleveEnCours: ligne.eleve_en_cours,
          demandeValidee: ligne.demande_validee,
          statutDossier: ligne.statut_dossier,
          rapprochement: ligne.rapprochement,
        },
        raison: ligne.raison,
      })).sort((a, b) => a.nom_prenom_normalise.localeCompare(b.nom_prenom_normalise, "fr"));
    }
    // Rollout : tant que le singleton détaillé n'a pas été initialisé.
    const [c, acquittements] = await Promise.all([
      calculerCompteur(ctx, undefined, true), lireAcquittements(ctx),
    ]);
    return construireAnomalies(c, acquittements);
  },
});

export const acquitterAnomalie = authenticatedMutation({
  args: {
    scrapId: v.id("abo_abonnes_scrap"),
    code_anomalie: codeAnomalieValidator,
    justification: v.string(),
  },
  returns: v.id("abo_anomalies_acquittements"),
  handler: async (ctx, args) => {
    const admin = await requireAboAdmin(ctx);
    const justification = args.justification.trim();
    if (justification.length === 0 || justification.length > 500) {
      throw new ConvexError({
        code: "ABO_JUSTIFICATION_INVALIDE",
        message: "La justification est obligatoire et limitée à 500 caractères.",
      });
    }

    const [cache, marqueur, anomaliesCache] = await Promise.all([
      ctx.db.query("abo_compteur_public_cache")
        .withIndex("by_cle", (q) => q.eq("cle", "courant")).first(),
      ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first(),
      ctx.db.query("abo_compteur_anomalies_cache")
        .withIndex("by_scrap_id", (q) => q.eq("scrap_id", args.scrapId)).take(5),
    ]);
    let licence: string | null;
    if (cacheCompteurComplet(cache) && !marqueur) {
      const ligneCache = anomaliesCache.find(
        (ligne) => ligne.code_anomalie === args.code_anomalie,
      );
      licence = canoniserLicence(ligneCache?.licence);
      if (!ligneCache) {
        throw new ConvexError({
          code: "ABO_ANOMALIE_OBSOLETE",
          message: "Cette anomalie a changé ou n'existe plus. Actualisez la liste avant de recommencer.",
        });
      }
    } else {
      // Fallback de rollout ou cache dirty : conserver une validation fraîche.
      const c = await calculerCompteur(ctx, undefined, true);
      const ligne = c.classifications.find(({ scrap }) => scrap._id === args.scrapId);
      if (!ligne || !estAnomalie(ligne) || codeAnomalieDe(ligne) !== args.code_anomalie) {
        throw new ConvexError({
          code: "ABO_ANOMALIE_OBSOLETE",
          message: "Cette anomalie a changé ou n'existe plus. Actualisez la liste avant de recommencer.",
        });
      }
      licence = canoniserLicence(ligne.scrap.licence);
    }
    if (!licence) {
      throw new ConvexError({
        code: "ABO_ANOMALIE_SANS_LICENCE",
        message: "Cette anomalie ne peut pas être acquittée tant qu'elle ne possède pas une licence valide.",
      });
    }
    const existant = await ctx.db
      .query("abo_anomalies_acquittements")
      .withIndex("by_licence_and_code_anomalie", (q) =>
        q.eq("licence", licence).eq("code_anomalie", args.code_anomalie))
      .unique();
    if (existant) {
      throw new ConvexError({
        code: "ABO_ANOMALIE_DEJA_ACQUITTEE",
        message: "Cette anomalie est déjà acquittée.",
      });
    }
    const maintenant = new Date().toISOString();
    const id = await ctx.db.insert("abo_anomalies_acquittements", {
      licence,
      code_anomalie: args.code_anomalie,
      justification,
      acquittee_le: maintenant,
      acquittee_par: admin.userId,
    });
    await ctx.db.insert("abo_anomalies_acquittements_journal", {
      licence,
      code_anomalie: args.code_anomalie,
      action: "acquittee",
      justification,
      date_action: maintenant,
      auteur_id: admin.userId,
    });
    await programmerRafraichissementCompteurPublic(ctx);
    return id;
  },
});

export const reactiverAnomalie = authenticatedMutation({
  args: { acquittementId: v.id("abo_anomalies_acquittements") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const admin = await requireAboAdmin(ctx);
    const acquittement = await ctx.db.get(args.acquittementId);
    if (!acquittement) {
      throw new ConvexError({
        code: "ABO_ACQUITTEMENT_INTROUVABLE",
        message: "Cet acquittement n'existe plus.",
      });
    }
    const maintenant = new Date().toISOString();
    await ctx.db.delete(acquittement._id);
    await ctx.db.insert("abo_anomalies_acquittements_journal", {
      licence: acquittement.licence,
      code_anomalie: acquittement.code_anomalie,
      action: "reactivee",
      justification: acquittement.justification,
      date_action: maintenant,
      auteur_id: admin.userId,
    });
    await programmerRafraichissementCompteurPublic(ctx);
    return null;
  },
});

// ── compteurPublic : agrégat ANONYME pour l'iframe du site club ──────
// 🔒 EXCEPTION DÉLIBÉRÉE à la règle « authenticatedQuery » : équivalent Convex de
// compteur_public() (SECURITY DEFINER, accordée à anon). L'iframe du club doit
// afficher les places sans connexion ; on ne renvoie donc QUE des ENTIERS
// (occupe / plafond / restantes), aucune donnée nominative n'est exposée.
// PUBLIC: endpoint anonyme assumé (iframe du site club).
export const compteurPublic = query({
  args: { maintenantMs: v.number() },
  returns: compteurPublicValidator,
  handler: async (ctx, args) => {
    const cache = await ctx.db
      .query("abo_compteur_public_cache")
      .withIndex("by_cle", (q) => q.eq("cle", "courant"))
      .first();
    const vague = await vagueCourante(ctx, args.maintenantMs);
    if (cache) {
      return {
        occupe: cache.occupe,
        places_max: cache.places_max,
        places_restantes: cache.places_restantes,
        vague,
      };
    }
    const c = await calculerCompteur(ctx, undefined);
    const places_max = await lirePlacesMax(ctx);
    return {
      occupe: c.total_affiche,
      places_max,
      places_restantes: places_max - c.total_affiche,
      vague,
    };
  },
});

// Invalidation durable : un scrap interrompu entre deux lots ne doit pas perdre
// son besoin de recalcul au prochain essai, même si ce dernier est identique.
export const rafraichirCompteurPublic = internalMutation({
  args: { siNecessaire: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cache = await ctx.db
      .query("abo_compteur_public_cache")
      .withIndex("by_cle", (q) => q.eq("cle", "courant"))
      .first();
    const marqueur = await ctx.db.query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLE_COMPTEUR_A_RECALCULER)).first();
    // Un ancien singleton PROD ne contient que les valeurs publiques. Il doit
    // être enrichi même sans changement métier lors du premier déploiement.
    if (args.siNecessaire && cacheCompteurComplet(cache) && !marqueur) return null;
    const [c, acquittements] = await Promise.all([
      calculerCompteur(ctx, undefined, true),
      lireAcquittements(ctx),
    ]);
    const anomalies = construireAnomalies(c, acquittements);
    const acquittees = anomalies.filter((ligne) => ligne.statut === "acquittee").length;
    const places_max = await lirePlacesMax(ctx);
    const calcule_le = new Date().toISOString();
    const doc = {
      cle: "courant" as const,
      occupe: c.total_affiche,
      places_max,
      places_restantes: places_max - c.total_affiche,
      abonnes_scrap: c.abonnes_scrap,
      abonnements_site_valides: c.abonnements_site_valides,
      abonnements_site_non_valides_a_suivre: c.abonnements_site_non_valides_a_suivre,
      legit_scrap: c.legit_scrap,
      demandes_validees: c.demandes_validees,
      demandes_liste_attente: c.demandes_liste_attente,
      demandes_refusees: c.demandes_refusees,
      demandes_a_traiter: c.demandes_a_traiter,
      validees_hors_legit: c.validees_hors_legit,
      bloquees: c.bloquees,
      anomalies: anomalies.length - acquittees,
      anomalies_brutes: anomalies.length,
      acquittees,
      total_affiche: c.total_affiche,
      occupe_transactionnel: c.occupe,
      calcule_le,
    };
    if (cache) {
      if (champsModifies(cache, doc, ["calcule_le"])) await ctx.db.patch(cache._id, doc);
    } else {
      await ctx.db.insert("abo_compteur_public_cache", doc);
    }

    const existantes = await ctx.db.query("abo_compteur_anomalies_cache")
      .take(MAX_LIGNES_COMPTEUR + 1);
    if (existantes.length > MAX_LIGNES_COMPTEUR) {
      throw new ConvexError({ code: "ABO_ANOMALIES_VOLUME", message: "Le cache des anomalies dépasse sa limite de sécurité." });
    }
    const parCle = new Map(existantes.map((ligne) => [ligne.cle, ligne] as const));
    for (const ligne of anomalies) {
      const cle = `${ligne.id}:${ligne.code_anomalie}`;
      const projection = {
        cle,
        scrap_id: ligne.id,
        licence: ligne.licence ?? undefined,
        nom: ligne.nom ?? undefined,
        prenom: ligne.prenom ?? undefined,
        nom_prenom_normalise: ligne.nom_prenom_normalise,
        abonnement_valide: ligne.abonnement_valide,
        code_anomalie: ligne.code_anomalie,
        peut_etre_acquittee: ligne.peutEtreAcquittee,
        statut: ligne.statut,
        acquittement_id: ligne.acquittement?.id,
        acquittement_justification: ligne.acquittement?.justification,
        acquittement_le: ligne.acquittement?.acquittee_le,
        type: ligne.type,
        abonne_n1: ligne.controles.abonneN1,
        abonne_n1_ambigu: ligne.controles.abonneN1Ambigu,
        eleve_en_cours: ligne.controles.eleveEnCours,
        demande_validee: ligne.controles.demandeValidee,
        statut_dossier: ligne.controles.statutDossier,
        rapprochement: ligne.controles.rapprochement,
        raison: ligne.raison,
        calcule_le,
      };
      const existante = parCle.get(cle);
      if (existante) {
        if (champsModifies(existante, projection, ["calcule_le"])) {
          await ctx.db.patch(existante._id, projection);
        }
        parCle.delete(cle);
      } else {
        await ctx.db.insert("abo_compteur_anomalies_cache", projection);
      }
    }
    for (const obsolete of parCle.values()) await ctx.db.delete(obsolete._id);
    if (marqueur) await ctx.db.delete(marqueur._id);
    return null;
  },
});

// ── getElevesEnCours : élèves en cours (admin) pour les badges ───────
// Renvoie une liste plate (licence / nom_prenom_normalise / horaire) ; le front
// construit les tables de matching (par licence, repli nom+prénom).
export const getElevesEnCours = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    licence: v.union(v.string(), v.null()),
    nom_prenom_normalise: v.string(),
    horaire: v.union(v.string(), v.null()),
  })),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const eleves = await ctx.db.query("abo_eleves_en_cours").collect();
    return eleves.map((e) => ({
      licence: e.licence ?? null,
      nom_prenom_normalise: e.nom_prenom_normalise,
      horaire: e.horaire ?? null,
    }));
  },
});

// ── setPlacesMax : plafond de places (admin) ─────────────────────────
export const setPlacesMax = authenticatedMutation({
  args: { places_max: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAboConfigurationManager(ctx);
    const n = Math.round(args.places_max);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConvexError({ code: "22023", message: "Nombre de places invalide." });
    }
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", "places_max"))
      .first();
    const patch = { valeur: String(n), updated_at: new Date().toISOString() };
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("abo_app_config", { cle: "places_max", ...patch });
    }
    await programmerRafraichissementCompteurPublic(ctx);
    return null;
  },
});

// ── remplacerElevesEnCours : import (interne, appelé par le scrap Phase H) ──
// Reçoit le snapshot COMPLET déjà filtré (hors « Liste d'attente »). Chaque
// inscription est identifiée par personne (licence canonique, sinon nom/prénom
// normalisé) + cours + horaire. Le rapprochement est un multiset : deux lignes
// strictement identiques restent deux inscriptions distinctes. On n'écrit que le
// vrai delta et on supprime toutes les lignes absentes du nouveau snapshot.
export const remplacerElevesEnCours = internalMutation({
  args: {
    saison: v.string(),
    lignes: v.array(
      v.object({
        licence: v.optional(v.string()),
        nom: v.optional(v.string()),
        prenom: v.optional(v.string()),
        horaire: v.optional(v.string()),
        age: v.optional(v.string()),
        cours: v.optional(v.string()),
        date_naissance: v.optional(v.string()),
        encadrants: v.optional(v.string()),
        date_inscription: v.optional(v.string()),
        licence_saison: v.optional(v.string()),
        licence_saisie: v.optional(v.string()),
        paiement_recu: v.optional(v.string()),
        paiements_dossier: v.optional(v.string()),
        saison_precedente: v.optional(v.string()),
        telephone_eleve: v.optional(v.string()),
        telephone_gestion: v.optional(v.string()),
        email_eleve: v.optional(v.string()),
        email_gestion: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    avecLicence: v.number(),
    sansLicence: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.lignes.length > MAX_ELEVES_SNAPSHOT) {
      throw new ConvexError({
        code: "54000",
        message: `L'import dépasse la limite de ${MAX_ELEVES_SNAPSHOT} inscriptions.`,
      });
    }

    const existants = await ctx.db
      .query("abo_eleves_en_cours")
      .take(MAX_ELEVES_SNAPSHOT + 1);
    if (existants.length > MAX_ELEVES_SNAPSHOT) {
      throw new ConvexError({
        code: "54000",
        message: `Le snapshot existant dépasse la limite de ${MAX_ELEVES_SNAPSHOT} inscriptions.`,
      });
    }

    const maintenant = new Date().toISOString();

    const doc = (l: (typeof args.lignes)[number], licence: string | undefined) => {
      const nom = (l.nom ?? "").trim() || undefined;
      const prenom = (l.prenom ?? "").trim() || undefined;
      return {
        licence,
        nom,
        prenom,
        nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        horaire: (l.horaire ?? "").trim() || undefined,
        saison: args.saison,
        imported_at: maintenant,
        age: l.age,
        cours: (l.cours ?? "").trim() || undefined,
        date_naissance: l.date_naissance,
        encadrants: l.encadrants,
        date_inscription: l.date_inscription,
        licence_saison: l.licence_saison,
        licence_saisie: l.licence_saisie,
        paiement_recu: l.paiement_recu,
        paiements_dossier: l.paiements_dossier,
        saison_precedente: l.saison_precedente,
        telephone_eleve: l.telephone_eleve,
        telephone_gestion: l.telephone_gestion,
        email_eleve: l.email_eleve,
        email_gestion: l.email_gestion,
      };
    };

    const identite = (ligne: {
      licence?: string | null;
      nom_prenom_normalise: string;
      cours?: string;
      horaire?: string;
    }): string => {
      const licence = canoniserLicence(ligne.licence);
      const personne = licence
        ? `licence:${licence}`
        : `nom:${ligne.nom_prenom_normalise}`;
      return JSON.stringify([
        personne,
        (ligne.cours ?? "").trim(),
        (ligne.horaire ?? "").trim(),
      ]);
    };

    const existantsParIdentite = new Map<string, Array<(typeof existants)[number]>>();
    for (const existant of existants) {
      const cle = identite(existant);
      const groupe = existantsParIdentite.get(cle);
      if (groupe) groupe.push(existant);
      else existantsParIdentite.set(cle, [existant]);
    }

    let avecLicence = 0;
    let sansLicence = 0;
    let snapshotModifie = false;
    for (const l of args.lignes) {
      const licence = canoniserLicence(l.licence) ?? undefined;
      const nouveau = doc(l, licence);
      if (!licence && !nouveau.nom_prenom_normalise) continue;

      if (licence) avecLicence++;
      else sansLicence++;

      const existant = existantsParIdentite.get(identite(nouveau))?.shift();
      if (existant) {
        if (champsModifies(existant, nouveau, ["imported_at"])) {
          await ctx.db.patch(existant._id, nouveau);
          snapshotModifie = true;
        }
      } else {
        await ctx.db.insert("abo_eleves_en_cours", nouveau);
        snapshotModifie = true;
      }
    }

    // Chaque existant non consommé a disparu du snapshot, quelle que soit sa
    // licence ou sa saison historique.
    for (const restants of existantsParIdentite.values()) {
      for (const e of restants) {
        await ctx.db.delete(e._id);
        snapshotModifie = true;
      }
    }

    // Le snapshot élèves reste prioritaire sur le suivi manuel. Après un
    // remplacement réussi, on supprime uniquement les traitements dont la
    // personne a disparu ou possède désormais une licence. Les identités
    // devenues ambiguës sont également retirées par prudence.
    const lignesCourantes = args.lignes
      .map((ligne) => doc(ligne, canoniserLicence(ligne.licence) ?? undefined))
      .filter((ligne) => ligne.nom_prenom_normalise);
    const occurrencesParNom = compterOccurrencesParNom(lignesCourantes);
    const clesEncoreSansLicence = new Set<string>();
    for (const ligne of lignesCourantes) {
      if (ligne.licence) continue;
      const identiteTraitement = construireIdentiteLicenceCours(
        ligne,
        occurrencesParNom,
      );
      if (identiteTraitement) clesEncoreSansLicence.add(identiteTraitement.cle);
    }

    // IO-BOUNDED: une identité au plus par personne du snapshot (1 000 lignes).
    const traitements = await ctx.db
      .query("abo_licences_cours_traitements")
      .take(MAX_ELEVES_SNAPSHOT + 1);
    if (traitements.length > MAX_ELEVES_SNAPSHOT) {
      throw new ConvexError({
        code: "54000",
        message: `Le suivi des traitements dépasse la limite de ${MAX_ELEVES_SNAPSHOT} personnes.`,
      });
    }
    for (const traitement of traitements) {
      if (!clesEncoreSansLicence.has(traitement.cle_identite)) {
        await ctx.db.delete(traitement._id);
      }
    }

    const cache = snapshotModifie ? null : await ctx.db
      .query("abo_compteur_public_cache")
      .withIndex("by_cle", (q) => q.eq("cle", "courant")).first();
    if (snapshotModifie || !cache) await programmerRafraichissementCompteurPublic(ctx);
    return { avecLicence, sansLicence };
  },
});
