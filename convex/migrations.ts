import { Migrations } from "@convex-dev/migrations";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authenticatedMutation as mutation } from "./customFunctions";
import { requireAdmin } from "./access";
import { canoniserEmailUnique } from "./emailValidation";
import schema from "./schema";

export const migrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { schema },
);

export const migrateSaisonsTransactions = migrations.define({
  table: "transactions",
  migrateOne: async (ctx, t) => {
    if (!t.saison) {
      await ctx.db.patch(t._id, { saison: "2025-26" });
    }
  },
});

export const migrateSaisonsPrevisionnels = migrations.define({
  table: "previsionnels",
  migrateOne: async (ctx, p) => {
    if (!p.saison) {
      await ctx.db.patch(p._id, { saison: "2025-26" });
    }
  },
});

export const migrateTypesDocuments = migrations.define({
  table: "transactions",
  migrateOne: async (ctx, t) => {
    if (!t.typeDocumentId && t.typeDocument) {
      const typeName = t.typeDocument.trim();
      
      // Chercher si le type existe déjà
      const existingTypes = await ctx.db.query("typesDocuments").collect();
      const existingType = existingTypes.find(td => td.nom.toLowerCase() === typeName.toLowerCase());

      let newTypeId;
      if (existingType) {
        newTypeId = existingType._id;
      } else {
        // Créer le type s'il n'existe pas
        newTypeId = await ctx.db.insert("typesDocuments", { nom: typeName });
      }

      // Mettre à jour la transaction avec l'ID
      await ctx.db.patch(t._id, {
        typeDocumentId: newTypeId,
      });
    }
  },
});

// WIDEN -> backfill -> NARROW of per-person submission metadata. This migration
// is intentionally defined only: do not run it without the club's approval.
export const migrateAboPersonnesDepot = migrations.define({
  table: "abo_personnes",
  migrateOne: async (ctx, personne) => {
    if (
      personne.vague_depot !== undefined &&
      personne.deposee_le !== undefined &&
      personne.echeance_decision === undefined &&
      personne.decision_validee_le === undefined
    ) return;
    await ctx.db.patch(personne._id, {
      vague_depot: personne.vague_depot ?? "historique",
      deposee_le: personne.deposee_le ?? new Date(personne._creationTime).toISOString(),
      echeance_decision: undefined,
      decision_validee_le: undefined,
    });
  },
});

type AboAbonnementValide = boolean | "oui" | "non" | "bloque" | "inconnu";
type AboAbonnementValideNormalise = Exclude<AboAbonnementValide, boolean>;

/** Conversion conservative : un ancien `false` ne distingue pas Non de Bloqué. */
export function normaliserAboAbonnementValide(
  statut: AboAbonnementValide,
): AboAbonnementValideNormalise {
  if (statut === true) return "oui";
  if (statut === false) return "inconnu";
  return statut;
}

// WIDEN -> backfill -> NARROW du statut provenant du site. Les migrations sont
// seulement définies ici : les exécuter séparément sur DEV puis PROD après accord.
export const migrateAboAbonnesScrapStatut = migrations.define({
  table: "abo_abonnes_scrap",
  migrateOne: async (ctx, abonne) => {
    if (typeof abonne.abonnement_valide === "string") return;
    await ctx.db.patch(abonne._id, {
      abonnement_valide: normaliserAboAbonnementValide(abonne.abonnement_valide),
    });
  },
});

export const migrateAboAbonnesArchiveStatut = migrations.define({
  table: "abo_abonnes_archive",
  migrateOne: async (ctx, abonne) => {
    if (typeof abonne.abonnement_valide === "string") return;
    await ctx.db.patch(abonne._id, {
      abonnement_valide: normaliserAboAbonnementValide(abonne.abonnement_valide),
    });
  },
});

type StatutMigrationEmail =
  | "sans_email"
  | "canonique"
  | "normalise"
  | "invalide"
  | "conflit";

const MAX_UTILISATEURS_INSPECTION_EMAIL = 2_000;

function essayerCanoniserEmail(email: string): string | null {
  try {
    return canoniserEmailUnique(email);
  } catch {
    return null;
  }
}

async function emailCanoniqueOccupeParUnAutre(
  ctx: Pick<MutationCtx | QueryCtx, "db">,
  utilisateur: Doc<"users">,
  emailCanonique: string,
): Promise<boolean> {
  // L'index `email` ne suffit pas pendant la transition : deux valeurs legacy
  // distinctes peuvent se canoniser vers la même adresse sans qu'une ligne ne
  // porte encore cette forme exacte. La lecture complète reste volontairement
  // bornée ; au-delà, la migration s'arrête avant toute décision ambiguë.
  const utilisateurs = await chargerPopulationUtilisateursEmail(ctx);

  return utilisateurs.some((candidat) => {
    if (candidat._id === utilisateur._id || candidat.email === undefined) {
      return false;
    }
    return essayerCanoniserEmail(candidat.email) === emailCanonique;
  });
}

async function chargerPopulationUtilisateursEmail(
  ctx: Pick<MutationCtx | QueryCtx, "db">,
): Promise<Doc<"users">[]> {
  const utilisateurs = await ctx.db
    .query("users")
    .take(MAX_UTILISATEURS_INSPECTION_EMAIL + 1);
  if (utilisateurs.length > MAX_UTILISATEURS_INSPECTION_EMAIL) {
    throw new Error(
      "Migration des emails interrompue : plus de 2000 utilisateurs, " +
        "une stratégie d'indexation dédiée est requise.",
    );
  }
  return utilisateurs;
}

/**
 * Normalise un compte isolé sans fusionner ni supprimer les comptes ambigus.
 * Exporté pour tester exactement la logique appelée par la migration.
 */
export async function migrerEmailUtilisateurCanonique(
  ctx: Pick<MutationCtx, "db">,
  utilisateur: Doc<"users">,
): Promise<StatutMigrationEmail> {
  if (utilisateur.email === undefined) return "sans_email";

  const emailCanonique = essayerCanoniserEmail(utilisateur.email);
  if (emailCanonique === null) return "invalide";
  if (emailCanonique === utilisateur.email) return "canonique";

  if (
    await emailCanoniqueOccupeParUnAutre(ctx, utilisateur, emailCanonique)
  ) {
    return "conflit";
  }

  await ctx.db.patch(utilisateur._id, { email: emailCanonique });
  return "normalise";
}

// Migration définie uniquement : exécution DEV puis PROD après inspection et
// accord explicite. Les conflits et formats invalides restent intacts pour
// arbitrage humain ; aucune fusion ou suppression de compte n'est effectuée.
export const migrateUsersEmailCanonique = migrations.define({
  table: "users",
  migrateOne: async (ctx, utilisateur) => {
    await migrerEmailUtilisateurCanonique(ctx, utilisateur);
  },
});

// Nettoyage ponctuel des erreurs de l'ancien flux Gmail, défini uniquement :
// exécution supervisée sur DEV puis PROD après confirmation de la cible.
// La présence de l'identifiant Gmail protège les imports créés par le webhook.
export const deleteAboReglementsImportsGmailEnErreur = migrations.define({
  table: "abo_reglements_imports",
  batchSize: 100,
  customRange: (query) =>
    query.withIndex("by_drive_file_id", (q) =>
      q.eq("drive_file_id", undefined),
    ),
  migrateOne: async (ctx, importReglement) => {
    if (
      importReglement.gmail_message_id === undefined ||
      importReglement.statut !== "erreur" ||
      importReglement.storage_id !== undefined
    ) {
      return;
    }
    await ctx.db.delete(importReglement._id);
  },
});

const MAX_CRENEAUX_PLANNING_PAR_SAMEDI = 25;
const MAX_AFFECTATIONS_PLANNING_PAR_CRENEAU = 10;
const MAX_OPERATIONS_PLANNING_PAR_CRENEAU = 25;

async function chargerCreneauxPlanningDuSamedi(
  ctx: Pick<MutationCtx, "db">,
  saison: string,
  date: string,
) {
  const creneaux = await ctx.db
    .query("planning_salaries_creneaux")
    .withIndex("by_saison_and_date", (q) =>
      q.eq("saison", saison).eq("date", date),
    )
    .take(MAX_CRENEAUX_PLANNING_PAR_SAMEDI + 1);
  if (creneaux.length > MAX_CRENEAUX_PLANNING_PAR_SAMEDI) {
    throw new Error(
      `Migration planning salariés bloquée pour ${saison}/${date} : ` +
        `plus de ${MAX_CRENEAUX_PLANNING_PAR_SAMEDI} événements le même samedi.`,
    );
  }
  return creneaux;
}

async function chargerAffectationsPlanningDuSamedi(
  ctx: Pick<MutationCtx, "db">,
  saison: string,
  date: string,
  creneaux: Doc<"planning_salaries_creneaux">[],
) {
  const parId = new Map<
    string,
    Doc<"planning_salaries_affectations">
  >();

  const dejaDatees = await ctx.db
    .query("planning_salaries_affectations")
    .withIndex("by_saison_and_date", (q) =>
      q.eq("saison", saison).eq("date", date),
    )
    .take(MAX_CRENEAUX_PLANNING_PAR_SAMEDI + 1);
  if (dejaDatees.length > MAX_CRENEAUX_PLANNING_PAR_SAMEDI) {
    throw new Error(
      `Migration planning salariés bloquée pour ${saison}/${date} : ` +
        "trop d'affectations déjà datées.",
    );
  }
  for (const affectation of dejaDatees) {
    parId.set(affectation._id, affectation);
  }

  for (const creneau of creneaux) {
    const affectations = await ctx.db
      .query("planning_salaries_affectations")
      .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
      .take(MAX_AFFECTATIONS_PLANNING_PAR_CRENEAU + 1);
    if (affectations.length > MAX_AFFECTATIONS_PLANNING_PAR_CRENEAU) {
      throw new Error(
        `Migration planning salariés bloquée pour le créneau ${creneau._id} : ` +
          "trop d'affectations historiques.",
      );
    }
    for (const affectation of affectations) {
      parId.set(affectation._id, affectation);
    }
  }

  return [...parId.values()];
}

/**
 * Transforme les affectations historiques par événement en une affectation
 * unique par samedi. Aucun arbitrage métier n'est fait : deux salariés
 * distincts sur la même date interrompent la migration avant toute écriture.
 */
export async function migrerAffectationPlanningVersSamedi(
  ctx: Pick<MutationCtx, "db">,
  affectationInitiale: Doc<"planning_salaries_affectations">,
) {
  const creneauInitial = affectationInitiale.creneauId
    ? await ctx.db.get(
        "planning_salaries_creneaux",
        affectationInitiale.creneauId,
      )
    : null;
  if (affectationInitiale.creneauId !== undefined && creneauInitial === null) {
    throw new Error(
      `Migration planning salariés bloquée : le créneau de l'affectation ` +
        `${affectationInitiale._id} n'existe plus.`,
    );
  }
  const date = affectationInitiale.date ?? creneauInitial?.date;
  if (date === undefined) {
    throw new Error(
      `Migration planning salariés bloquée : l'affectation ${affectationInitiale._id} ` +
        "n'a ni date ni créneau existant.",
    );
  }
  if (
    creneauInitial !== null &&
    (creneauInitial.saison !== affectationInitiale.saison ||
      (affectationInitiale.date !== undefined &&
        affectationInitiale.date !== creneauInitial.date))
  ) {
    throw new Error(
      `Migration planning salariés bloquée : date ou saison incohérente pour ` +
        `l'affectation ${affectationInitiale._id}.`,
    );
  }

  const creneaux = await chargerCreneauxPlanningDuSamedi(
    ctx,
    affectationInitiale.saison,
    date,
  );
  const affectations = await chargerAffectationsPlanningDuSamedi(
    ctx,
    affectationInitiale.saison,
    date,
    creneaux,
  );
  for (const affectation of affectations) {
    if (
      affectation.saison !== affectationInitiale.saison ||
      (affectation.date !== undefined && affectation.date !== date)
    ) {
      throw new Error(
        `Migration planning salariés bloquée : date ou saison incohérente pour ` +
          `l'affectation ${affectation._id}.`,
      );
    }
  }
  const salaries = new Set(affectations.map((item) => item.salarieId));
  if (salaries.size > 1) {
    throw new Error(
      `CONFLIT_PLANNING_SALARIES ${affectationInitiale.saison}/${date} : ` +
        "plusieurs salariés distincts sont affectés. Arbitrage humain requis.",
    );
  }
  if (affectations.length === 0) return;

  const [canonique, ...doublons] = affectations.sort((a, b) => {
    const aDejaMigree = a.date === date && a.creneauId === undefined ? 0 : 1;
    const bDejaMigree = b.date === date && b.creneauId === undefined ? 0 : 1;
    return (
      aDejaMigree - bDejaMigree ||
      a.createdAt - b.createdAt ||
      a._creationTime - b._creationTime ||
      String(a._id).localeCompare(String(b._id))
    );
  });
  const idsFusionnes = new Set(affectations.map((item) => item._id));

  for (const creneau of creneaux) {
    const operations = await ctx.db
      .query("planning_salaries_google_operations")
      .withIndex("by_creneauId", (q) => q.eq("creneauId", creneau._id))
      .take(MAX_OPERATIONS_PLANNING_PAR_CRENEAU + 1);
    if (operations.length > MAX_OPERATIONS_PLANNING_PAR_CRENEAU) {
      throw new Error(
        `Migration planning salariés bloquée pour le créneau ${creneau._id} : ` +
          "trop d'opérations Google historiques.",
      );
    }
    for (const operation of operations) {
      const affectationId =
        operation.affectationId !== undefined &&
        idsFusionnes.has(operation.affectationId)
          ? canonique._id
          : operation.affectationId;
      if (
        operation.date !== date ||
        affectationId !== operation.affectationId
      ) {
        await ctx.db.patch(operation._id, { date, affectationId });
      }
    }
  }

  if (canonique.date !== date || canonique.creneauId !== undefined) {
    await ctx.db.patch(canonique._id, { date, creneauId: undefined });
  }
  for (const doublon of doublons) {
    await ctx.db.delete(doublon._id);
  }
}

// WIDEN -> MIGRATE : définition uniquement. Exécuter sur DEV puis PROD après
// dry-run et résolution manuelle de chaque CONFLIT_PLANNING_SALARIES.
export const migratePlanningSalariesAffectationsParSamedi = migrations.define({
  table: "planning_salaries_affectations",
  batchSize: 10,
  migrateOne: migrerAffectationPlanningVersSamedi,
});

// Complète les opérations sans affectation (ou non rencontrées par la fusion).
// À chaîner après migratePlanningSalariesAffectationsParSamedi.
export const migratePlanningSalariesOperationsDate = migrations.define({
  table: "planning_salaries_google_operations",
  batchSize: 50,
  migrateOne: async (ctx, operation) => {
    if (operation.date !== undefined) return;
    const creneau = await ctx.db.get(
      "planning_salaries_creneaux",
      operation.creneauId,
    );
    if (creneau === null || creneau.saison !== operation.saison) {
      throw new Error(
        `Migration planning salariés bloquée : créneau absent ou saison ` +
          `incohérente pour l'opération ${operation._id}.`,
      );
    }
    await ctx.db.patch(operation._id, { date: creneau.date });
  },
});

const vInspectionEmailsUtilisateurs = v.object({
  lus: v.number(),
  sans_email: v.number(),
  canonique: v.number(),
  a_normaliser: v.number(),
  invalide: v.number(),
  conflit: v.number(),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

function compterEmailsCanoniques(
  utilisateurs: Doc<"users">[],
): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const utilisateur of utilisateurs) {
    if (utilisateur.email === undefined) continue;
    const emailCanonique = essayerCanoniserEmail(utilisateur.email);
    if (emailCanonique === null) continue;
    occurrences.set(
      emailCanonique,
      (occurrences.get(emailCanonique) ?? 0) + 1,
    );
  }
  return occurrences;
}

function classifierEmailUtilisateur(
  utilisateur: Doc<"users">,
  occurrences: Map<string, number>,
): Exclude<StatutMigrationEmail, "normalise"> | "a_normaliser" {
  if (utilisateur.email === undefined) return "sans_email";

  const emailCanonique = essayerCanoniserEmail(utilisateur.email);
  if (emailCanonique === null) return "invalide";
  if ((occurrences.get(emailCanonique) ?? 0) > 1) {
    return "conflit";
  }
  return emailCanonique === utilisateur.email ? "canonique" : "a_normaliser";
}

// Inspection interne, paginée et sans PII. Après migration, seuls les
// compteurs `canonique`, `sans_email`, `invalide` et `conflit` doivent rester.
export const inspectUsersEmailCanonique = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: vInspectionEmailsUtilisateurs,
  handler: async (ctx, args) => {
    const [page, utilisateurs] = await Promise.all([
      ctx.db.query("users").paginate(args.paginationOpts),
      chargerPopulationUtilisateursEmail(ctx),
    ]);
    const occurrences = compterEmailsCanoniques(utilisateurs);
    const resume = {
      lus: page.page.length,
      sans_email: 0,
      canonique: 0,
      a_normaliser: 0,
      invalide: 0,
      conflit: 0,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };

    const categories = page.page.map((utilisateur) =>
      classifierEmailUtilisateur(utilisateur, occurrences),
    );
    for (const categorie of categories) resume[categorie]++;
    return resume;
  },
});

const vInspectionStatuts = v.object({
  lus: v.number(),
  booleens_legacy: v.number(),
  oui: v.number(),
  non: v.number(),
  bloque: v.number(),
  inconnu: v.number(),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

function resumerStatuts(
  statuts: AboAbonnementValide[],
  continueCursor: string,
  isDone: boolean,
) {
  const resume = {
    lus: statuts.length,
    booleens_legacy: 0,
    oui: 0,
    non: 0,
    bloque: 0,
    inconnu: 0,
    continueCursor,
    isDone,
  };
  for (const statut of statuts) {
    if (typeof statut === "boolean") resume.booleens_legacy++;
    else resume[statut]++;
  }
  return resume;
}

// Inspection interne, paginée et non nominative à utiliser avant le narrowing.
export const inspectAboAbonnesScrapStatut = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: vInspectionStatuts,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("abo_abonnes_scrap")
      .paginate(args.paginationOpts);
    return resumerStatuts(
      page.page.map((abonne) => abonne.abonnement_valide),
      page.continueCursor,
      page.isDone,
    );
  },
});

export const inspectAboAbonnesArchiveStatut = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: vInspectionStatuts,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("abo_abonnes_archive")
      .paginate(args.paginationOpts);
    return resumerStatuts(
      page.page.map((abonne) => abonne.abonnement_valide),
      page.continueCursor,
      page.isDone,
    );
  },
});

export const seedSaisons = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx, ctx.userId);
    const defaultSeasons = ["2023-24", "2024-25", "2025-26", "2026-27"];
    const existingSaisons = await ctx.db.query("saisons").collect();
    
    if (existingSaisons.length === 0) {
      for (const nom of defaultSeasons) {
        await ctx.db.insert("saisons", {
          nom,
          isDefault: nom === "2025-26"
        });
      }
      return { success: true, message: "Saisons initialisées avec succès." };
    }
    return { success: true, message: "Saisons déjà existantes." };
  },
});
