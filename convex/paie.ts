import { authenticatedQuery as query, authenticatedMutation as mutation } from "./customFunctions";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { previousSaison, nextSaison } from "./saisonUtils";
import { computePaie, type ParametresPaie } from "../src/utils/paieCompute";
import { requireTile } from "./access";

const typeContratValidator = v.union(v.literal("CDII"), v.literal("CDI"));

const heuresSupValidator = v.array(
  v.object({
    designation: v.string(),
    nbHeures: v.number(),
    // true = heures de compétition, false/absent = loisir.
    competition: v.optional(v.boolean()),
  })
);

const cotisSalarialeValidator = v.object({
  label: v.string(),
  taux: v.number(),
  base: v.string(),
});
const cotisPatronaleValidator = v.object({
  label: v.string(),
  taux: v.number(),
});

// --- Paramètres de paie par défaut (issus de l'onglet « Fiche de Paie ») ---

const DEFAULT_COTIS_SALARIALES = [
  { label: "Assurance vieillesse plafonnée", taux: 6.9, base: "brut" },
  { label: "Assurance vieillesse totalité", taux: 0.4, base: "brut" },
  { label: "Retraite complémentaire plafonnée", taux: 3.15, base: "brut" },
  { label: "Contribution d'équilibre général T1", taux: 0.86, base: "brut" },
  { label: "Régime de base obligatoire", taux: 0.29, base: "brut" },
  { label: "Régime de base obligatoire (micro)", taux: 2.9, base: "micro" },
  { label: "Régime de base obligatoire (micro)", taux: 6.8, base: "micro" },
  { label: "CSG et CRDS", taux: 2.9, base: "csgcrds" },
  { label: "CSG déductible fiscalement", taux: 6.8, base: "csgcrds" },
];

const DEFAULT_COTIS_PATRONALES = [
  { label: "Assurance maladie", taux: 7 },
  { label: "Contribution solidarité", taux: 0.3 },
  { label: "Assurance vieillesse plafonnée", taux: 8.55 },
  { label: "Assurance vieillesse totalité", taux: 1.9 },
  { label: "Allocations familiales", taux: 3.45 },
  { label: "Accident du travail", taux: 0.77 },
  { label: "FNAL", taux: 0.1 },
  { label: "Retraite complémentaire plafonnée", taux: 4.72 },
  { label: "Contribution d'équilibre général T1", taux: 1.29 },
  { label: "Régime de base obligatoire", taux: 0.29 },
  { label: "Chômage totalité", taux: 4.05 },
  { label: "Assedic FNGS", taux: 0.15 },
  { label: "Formation professionnelle", taux: 1.07 },
  { label: "Formation prof. légale", taux: 0.55 },
  { label: "Cotisation CIF dirigeants et paritarisme", taux: 0.06 },
  { label: "Contrib. organisations syndicales", taux: 0.016 },
  { label: "Prévoyance", taux: 0.83 },
];

const DEFAULT_PARAMS = {
  margeSecurite: 1.02,
  indemniteCpPct: 10,
  mutuelleSalarie: 20,
  mutuelleEmployeur: 20,
  primeEquipementAnnuelle: 210,
  fraisBulletin: 14,
  cotisationsSalariales: DEFAULT_COTIS_SALARIALES,
  cotisationsPatronales: DEFAULT_COTIS_PATRONALES,
};

// --- Données historiques réelles (source : Budget_Escalade / Salaire be.csv) ---
// Le taux horaire d'une saison est DÉRIVÉ : taux(N) = taux(N-1) × (1 + augmentation).
// La base est 2023-24. Pour un nouvel arrivant, on saisit un taux d'entrée (baseRate).
// Pour les CDI, nbHeuresAnnuel = heures « budget » saisies ; la conversion en heures
// réelles est faite au calcul (cf. heuresAnnuellesEffectives).

const SEED_MONITEURS: Record<string, { typeContrat: "CDII" | "CDI"; ordre: number }> = {
  "Clémentine": { typeContrat: "CDII", ordre: 0 },
  "David": { typeContrat: "CDII", ordre: 1 },
  "Raphaël": { typeContrat: "CDII", ordre: 2 },
  "Stéphane": { typeContrat: "CDII", ordre: 3 },
  "Nicolas": { typeContrat: "CDII", ordre: 4 },
  "Jérôme": { typeContrat: "CDI", ordre: 5 },
  "Hugo": { typeContrat: "CDI", ordre: 6 },
  "Gael": { typeContrat: "CDI", ordre: 7 },
};

// Données par saison/moniteur. `baseRate` = taux d'entrée (saison de référence ou
// nouvel arrivant) ; sinon le taux est calculé via `augmentationPct` sur la saison N-1.
type SeedLigne = {
  baseRate?: number;
  augmentationPct?: number;
  nbHeuresAnnuel: number;
  nbMois: number;
};

const SEED_DATA: Array<{ saison: string; lignes: Record<string, SeedLigne> }> = [
  {
    // 2023-24 : saison de référence (taux de base, heures inconnues dans la source).
    saison: "2023-24",
    lignes: {
      "Clémentine": { baseRate: 19, nbHeuresAnnuel: 0, nbMois: 12 },
      "David": { baseRate: 21.21, nbHeuresAnnuel: 0, nbMois: 12 },
      "Raphaël": { baseRate: 21.21, nbHeuresAnnuel: 0, nbMois: 10 },
      "Stéphane": { baseRate: 19, nbHeuresAnnuel: 0, nbMois: 12 },
      "Nicolas": { baseRate: 20, nbHeuresAnnuel: 0, nbMois: 12 },
      "Jérôme": { baseRate: 19, nbHeuresAnnuel: 0, nbMois: 12 },
      "Hugo": { baseRate: 19, nbHeuresAnnuel: 0, nbMois: 12 },
    },
  },
  {
    // 2024-25 : augmentation vs 2023-24.
    saison: "2024-25",
    lignes: {
      "Clémentine": { augmentationPct: 3.5, nbHeuresAnnuel: 740, nbMois: 12 },
      "David": { augmentationPct: 3.5, nbHeuresAnnuel: 280, nbMois: 12 },
      "Raphaël": { augmentationPct: 4.2, nbHeuresAnnuel: 760, nbMois: 10 },
      "Stéphane": { augmentationPct: 3.5, nbHeuresAnnuel: 280, nbMois: 12 },
      "Nicolas": { augmentationPct: 3.5, nbHeuresAnnuel: 180, nbMois: 12 },
      "Jérôme": { augmentationPct: 3.7, nbHeuresAnnuel: 925, nbMois: 12 },
      "Hugo": { augmentationPct: 3.7, nbHeuresAnnuel: 931, nbMois: 12 },
    },
  },
  {
    // 2025-26 : augmentation vs 2024-25 ; Hugo parti, Gael arrivé (taux d'entrée).
    saison: "2025-26",
    lignes: {
      "Clémentine": { augmentationPct: 3, nbHeuresAnnuel: 740, nbMois: 12 },
      "David": { augmentationPct: 3, nbHeuresAnnuel: 280, nbMois: 12 },
      "Raphaël": { augmentationPct: 3, nbHeuresAnnuel: 760, nbMois: 10 },
      "Stéphane": { augmentationPct: 3, nbHeuresAnnuel: 280, nbMois: 12 },
      "Nicolas": { augmentationPct: 3, nbHeuresAnnuel: 180, nbMois: 12 },
      "Jérôme": { augmentationPct: 9.65, nbHeuresAnnuel: 1150, nbMois: 12 },
      "Gael": { baseRate: 21.6, nbHeuresAnnuel: 515, nbMois: 12 },
    },
  },
];

/** Heures de réunion ajoutées chaque saison à tout moniteur (catégorie loisir). */
export const HEURES_REUNION = 5;

/** Coefficient de préparation : 1 h de cours = 1 h 15 payée (15 min de préparation). */
export const COEF_PREPARATION = 1.25;

type HeuresCat = { loisir: number; competition: number };

/** Heures de cours annuelles par moniteur, ventilées loisir/compétition, déduites du
 *  planning : Σ (durée hebdo du cours × semaines couvertes) selon la catégorie du cours.
 *  `hasCours` indique si la saison a un planning (sinon on retombe sur les heures saisies). */
async function heuresCoursParMoniteur(
  ctx: QueryCtx,
  saison: string
): Promise<{ map: Map<Id<"salaries">, HeuresCat>; hasCours: boolean }> {
  const cours = await ctx.db
    .query("cours")
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .collect();
  const map = new Map<Id<"salaries">, HeuresCat>();
  for (const c of cours) {
    const cat: keyof HeuresCat = c.competition ? "competition" : "loisir";
    const heuresSemaine = c.seances.reduce((a, s) => a + s.dureeHeures, 0);
    for (const m of c.moniteurs) {
      const cur = map.get(m.salarieId) ?? { loisir: 0, competition: 0 };
      // 1 h de cours compte 1 h 15 (15 min de préparation).
      cur[cat] += heuresSemaine * m.nbSemaines * COEF_PREPARATION;
      map.set(m.salarieId, cur);
    }
  }
  return { map, hasCours: cours.length > 0 };
}

/** Construit une ligne de salaire enrichie (infos salarié + ventilation horaire
 *  loisir/compétition). Partagé entre `getMasseSalariale` et le calcul de la masse
 *  salariale reportée dans le prévisionnel / les tendances. */
function makeToRow(
  ctx: QueryCtx,
  heures: { map: Map<Id<"salaries">, HeuresCat>; hasCours: boolean }
) {
  return async (ligne: Doc<"salairesSaison">) => {
    const salarie = await ctx.db.get(ligne.salarieId);
    const base = heures.map.get(ligne.salarieId) ?? { loisir: 0, competition: 0 };
    const heuresSup = ligne.heuresSup ?? [];

    let heuresLoisir: number;
    let heuresCompetition: number;
    let nbHeuresAnnuel: number;
    if (heures.hasCours) {
      // Cours (par catégorie) + 5h de réunion (loisir) + heures sup déclarées.
      let loisir = base.loisir + HEURES_REUNION;
      let competition = base.competition;
      for (const hs of heuresSup) {
        if (hs.competition) competition += hs.nbHeures;
        else loisir += hs.nbHeures;
      }
      // Totaux annuels arrondis (pas de virgule).
      heuresLoisir = Math.round(loisir);
      heuresCompetition = Math.round(competition);
      nbHeuresAnnuel = heuresLoisir + heuresCompetition;
    } else {
      nbHeuresAnnuel = ligne.nbHeuresAnnuel;
      heuresLoisir = ligne.nbHeuresAnnuel;
      heuresCompetition = 0;
    }

    return {
      ligneId: ligne._id,
      salarieId: ligne.salarieId,
      nom: salarie?.nom ?? "Inconnu",
      typeContrat: salarie?.typeContrat ?? "CDII",
      ordre: salarie?.ordre ?? 0,
      nbHeuresAnnuel,
      heuresLoisir,
      heuresCompetition,
      heuresSup,
      heuresAuto: heures.hasCours,
      nbMois: ligne.nbMois,
      tauxHoraireBrut: ligne.tauxHoraireBrut,
      augmentationPct: ligne.augmentationPct ?? null,
      actif: ligne.actif ?? true,
    };
  };
}

/** Convertit les paramètres bruts (Convex) vers le type attendu par `computePaie`. */
export function toParametresPaie(params: Doc<"parametresPaie">): ParametresPaie {
  return {
    margeSecurite: params.margeSecurite,
    indemniteCpPct: params.indemniteCpPct,
    mutuelleSalarie: params.mutuelleSalarie,
    mutuelleEmployeur: params.mutuelleEmployeur,
    primeEquipementAnnuelle: params.primeEquipementAnnuelle,
    fraisBulletin: params.fraisBulletin,
    cotisationsSalariales: params.cotisationsSalariales.map((c) => ({
      label: c.label,
      taux: c.taux,
      base: c.base as ParametresPaie["cotisationsSalariales"][number]["base"],
    })),
    cotisationsPatronales: params.cotisationsPatronales,
  };
}

/** Coût employeur annuel de la masse salariale d'une saison, ventilé loisir /
 *  compétition au prorata des heures de chaque moniteur. Reproduit fidèlement le
 *  calcul `masseSalarialeSplit` de la page Masse salariale, mais côté serveur, afin
 *  de reporter la masse salariale dans les tendances du budget.
 *  Renvoie `null` si la saison n'a pas d'heures (saison de référence) — dans ce cas
 *  aucun coût employeur n'est affiché, comme sur le front. */
export async function computeMasseSalarialeSplit(
  ctx: QueryCtx,
  saison: string
): Promise<{ loisir: number; competition: number } | null> {
  const params = await ctx.db
    .query("parametresPaie")
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .first();
  if (!params) return null;

  const lignes = await ctx.db
    .query("salairesSaison")
    .withIndex("by_saison", (q) => q.eq("saison", saison))
    .collect();
  if (lignes.length === 0) return null;

  const heuresCours = await heuresCoursParMoniteur(ctx, saison);
  const rows = await Promise.all(lignes.map(makeToRow(ctx, heuresCours)));

  const seasonHasHours = rows.some((r) => r.nbHeuresAnnuel > 0);
  if (!seasonHasHours) return null;

  const p = toParametresPaie(params);
  let loisir = 0;
  let competition = 0;
  for (const s of rows) {
    const base = computePaie(
      {
        nom: s.nom,
        typeContrat: s.typeContrat,
        nbHeuresAnnuel: s.nbHeuresAnnuel,
        nbMois: s.nbMois,
        tauxHoraireBrut: s.tauxHoraireBrut,
      },
      p
    );
    const total = s.heuresLoisir + s.heuresCompetition;
    if (total > 0) {
      loisir += base.coutAnnuel * (s.heuresLoisir / total);
      competition += base.coutAnnuel * (s.heuresCompetition / total);
    } else {
      loisir += base.coutAnnuel;
    }
  }
  return { loisir, competition };
}

export const getMasseSalariale = query({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    const params = await ctx.db
      .query("parametresPaie")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .first();

    const lignes = await ctx.db
      .query("salairesSaison")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .collect();

    // Saison précédente (augmentation vs N-1 + comparaison de coût) : lignes + paramètres.
    const prevSaison = previousSaison(args.saison);
    const prevLignes = prevSaison
      ? await ctx.db
          .query("salairesSaison")
          .withIndex("by_saison", (q) => q.eq("saison", prevSaison))
          .collect()
      : [];
    const prevParams = prevSaison
      ? await ctx.db
          .query("parametresPaie")
          .withIndex("by_saison", (q) => q.eq("saison", prevSaison))
          .first()
      : null;

    // Heures de cours par moniteur (saison courante + précédente). Quand un planning
    // existe, les heures sont calculées (cours + 5h réunion + heures sup déclarées) ;
    // sinon on conserve les heures saisies (saisons historiques / de référence).
    const heuresCours = await heuresCoursParMoniteur(ctx, args.saison);
    const prevHeuresCours = prevSaison
      ? await heuresCoursParMoniteur(ctx, prevSaison)
      : { map: new Map<Id<"salaries">, HeuresCat>(), hasCours: false };

    const toRow = makeToRow(ctx, heuresCours);
    const prevToRow = makeToRow(ctx, prevHeuresCours);

    const prevSalaries = await Promise.all(prevLignes.map(prevToRow));
    const prevBySalarie = new Map(prevSalaries.map((p) => [p.salarieId, p]));

    const salaries = (await Promise.all(lignes.map(toRow))).map((row) => ({
      ...row,
      tauxPrecedent: prevBySalarie.get(row.salarieId)?.tauxHoraireBrut ?? null,
    }));

    salaries.sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom));
    prevSalaries.sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom));

    return { params, salaries, prevSalaries, prevParams, prevSaison };
  },
});

/** Taux dérivé : taux(N) = taux(N-1) × (1 + augmentation%).
 *  Précision pleine conservée (comme l'Excel) : seul le salaire est arrondi au calcul. */
function deriveTaux(prevRate: number, augmentationPct: number): number {
  return prevRate * (1 + augmentationPct / 100);
}

// Purge des données de masse salariale (réservé à la ré-initialisation du seed).
// `npx convex run paie:resetMasseSalariale`
export const resetMasseSalariale = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["salairesSaison", "parametresPaie", "salaries"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const d of docs) await ctx.db.delete(d._id);
    }
    return "Tables masse salariale vidées.";
  },
});

/** Taux horaire du même moniteur lors de la saison précédente (ou null). */
async function tauxSaisonPrecedente(
  ctx: MutationCtx,
  salarieId: Id<"salaries">,
  saison: string
): Promise<number | null> {
  const prev = previousSaison(saison);
  if (!prev) return null;
  const ligne = await ctx.db
    .query("salairesSaison")
    .withIndex("by_saison", (q) => q.eq("saison", prev))
    .filter((q) => q.eq(q.field("salarieId"), salarieId))
    .first();
  return ligne?.tauxHoraireBrut ?? null;
}

/** Propage un changement de taux aux saisons suivantes du même moniteur :
 *  taux(N+1) = taux(N) × (1 + augmentation(N+1)). S'arrête dès qu'une saison
 *  suivante est absente ou a un taux d'entrée (pas d'augmentation). */
async function cascadeTaux(
  ctx: MutationCtx,
  salarieId: Id<"salaries">,
  saison: string,
  tauxSaison: number
): Promise<void> {
  let currentSaison = saison;
  let currentTaux = tauxSaison;
  for (let i = 0; i < 50; i++) {
    const next = nextSaison(currentSaison);
    if (!next) break;
    const ligne = await ctx.db
      .query("salairesSaison")
      .withIndex("by_saison", (q) => q.eq("saison", next))
      .filter((q) => q.eq(q.field("salarieId"), salarieId))
      .first();
    if (!ligne || ligne.augmentationPct == null) break; // taux d'entrée / absent → stop
    const nouveauTaux = deriveTaux(currentTaux, ligne.augmentationPct);
    if (nouveauTaux !== ligne.tauxHoraireBrut) {
      await ctx.db.patch(ligne._id, { tauxHoraireBrut: nouveauTaux });
    }
    currentSaison = next;
    currentTaux = nouveauTaux;
  }
}

// Amorçage one-shot des données historiques réelles (2023-24 → 2025-26).
// À lancer une fois via la CLI : `npx convex run paie:seedHistorique`
// Idempotent : ne recrée pas une ligne déjà présente pour une saison donnée.
// Le taux est dérivé saison par saison (base 2023-24 + chaîne d'augmentation).
export const seedHistorique = internalMutation({
  args: {},
  handler: async (ctx) => {
    const results: string[] = [];

    // Paramètres de paie par défaut, par saison (si absents).
    for (const { saison } of SEED_DATA) {
      const existingParams = await ctx.db
        .query("parametresPaie")
        .withIndex("by_saison", (q) => q.eq("saison", saison))
        .first();
      if (!existingParams) {
        await ctx.db.insert("parametresPaie", { saison, ...DEFAULT_PARAMS });
        results.push(`Paramètres créés : ${saison}`);
      }
    }

    // Salariés (identité unique).
    const allSalaries = await ctx.db.query("salaries").collect();
    const salarieIdByNom = new Map<string, Id<"salaries">>(
      allSalaries.map((s) => [s.nom, s._id])
    );
    for (const [nom, info] of Object.entries(SEED_MONITEURS)) {
      if (!salarieIdByNom.has(nom)) {
        const id = await ctx.db.insert("salaries", {
          nom, typeContrat: info.typeContrat, ordre: info.ordre,
        });
        salarieIdByNom.set(nom, id);
      }
    }

    // Lignes de saison, dans l'ordre chronologique, en chaînant les taux.
    const lastRateByNom = new Map<string, number>();
    let created = 0;
    for (const { saison, lignes } of SEED_DATA) {
      for (const [nom, l] of Object.entries(lignes)) {
        const taux =
          l.baseRate !== undefined
            ? l.baseRate
            : deriveTaux(lastRateByNom.get(nom) ?? 0, l.augmentationPct ?? 0);
        lastRateByNom.set(nom, taux);

        const salarieId = salarieIdByNom.get(nom)!;
        const exists = await ctx.db
          .query("salairesSaison")
          .withIndex("by_saison", (q) => q.eq("saison", saison))
          .filter((q) => q.eq(q.field("salarieId"), salarieId))
          .first();
        if (exists) continue;
        await ctx.db.insert("salairesSaison", {
          salarieId,
          saison,
          nbHeuresAnnuel: l.nbHeuresAnnuel,
          nbMois: l.nbMois,
          tauxHoraireBrut: taux,
          augmentationPct: l.augmentationPct,
          actif: true,
        });
        created++;
      }
    }
    results.push(`${created} lignes de salaire créées.`);
    return results;
  },
});

export const addSalarie = mutation({
  args: {
    nom: v.string(),
    typeContrat: typeContratValidator,
    saison: v.string(),
    nbHeuresAnnuel: v.optional(v.number()),
    nbMois: v.number(),
    tauxHoraireBrut: v.number(),
    augmentationPct: v.optional(v.number()),
    heuresSup: v.optional(heuresSupValidator),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    const nom = args.nom.trim();
    if (!nom) throw new Error("Le nom est obligatoire.");

    const count = (await ctx.db.query("salaries").collect()).length;
    const salarieId = await ctx.db.insert("salaries", {
      nom,
      typeContrat: args.typeContrat,
      ordre: count,
    });
    // Taux dérivé si le moniteur existait la saison précédente, sinon taux d'entrée saisi.
    const prevRate = await tauxSaisonPrecedente(ctx, salarieId, args.saison);
    const taux =
      prevRate != null && args.augmentationPct !== undefined
        ? deriveTaux(prevRate, args.augmentationPct)
        : args.tauxHoraireBrut;
    await ctx.db.insert("salairesSaison", {
      salarieId,
      saison: args.saison,
      nbHeuresAnnuel: args.nbHeuresAnnuel ?? 0,
      nbMois: args.nbMois,
      tauxHoraireBrut: taux,
      augmentationPct: args.augmentationPct,
      actif: true,
      heuresSup: args.heuresSup ?? [],
    });
    return salarieId;
  },
});

export const updateSalarie = mutation({
  args: {
    salarieId: v.id("salaries"),
    ligneId: v.id("salairesSaison"),
    nom: v.optional(v.string()),
    typeContrat: v.optional(typeContratValidator),
    nbHeuresAnnuel: v.optional(v.number()),
    nbMois: v.optional(v.number()),
    tauxHoraireBrut: v.optional(v.number()),
    augmentationPct: v.optional(v.number()),
    actif: v.optional(v.boolean()),
    heuresSup: v.optional(heuresSupValidator),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");

    const salarieUpdates: Record<string, unknown> = {};
    if (args.nom !== undefined) {
      const nom = args.nom.trim();
      if (!nom) throw new Error("Le nom est obligatoire.");
      salarieUpdates.nom = nom;
    }
    if (args.typeContrat !== undefined) salarieUpdates.typeContrat = args.typeContrat;
    if (Object.keys(salarieUpdates).length > 0) {
      await ctx.db.patch(args.salarieId, salarieUpdates);
    }

    const ligne = await ctx.db.get(args.ligneId);
    if (!ligne) throw new Error("Ligne de salaire introuvable.");

    const ligneUpdates: Record<string, unknown> = {};
    if (args.nbHeuresAnnuel !== undefined) ligneUpdates.nbHeuresAnnuel = args.nbHeuresAnnuel;
    if (args.nbMois !== undefined) ligneUpdates.nbMois = args.nbMois;
    if (args.actif !== undefined) ligneUpdates.actif = args.actif;
    if (args.heuresSup !== undefined) ligneUpdates.heuresSup = args.heuresSup;

    // Le taux est DÉRIVÉ de l'augmentation si le moniteur existait la saison
    // précédente ; sinon (saison de référence / nouvel arrivant) le taux saisi fait foi.
    const prevRate = await tauxSaisonPrecedente(ctx, args.salarieId, ligne.saison);
    if (prevRate != null) {
      if (args.augmentationPct !== undefined) {
        ligneUpdates.augmentationPct = args.augmentationPct;
        ligneUpdates.tauxHoraireBrut = deriveTaux(prevRate, args.augmentationPct);
      }
    } else {
      if (args.augmentationPct !== undefined) ligneUpdates.augmentationPct = args.augmentationPct;
      if (args.tauxHoraireBrut !== undefined) ligneUpdates.tauxHoraireBrut = args.tauxHoraireBrut;
    }

    if (Object.keys(ligneUpdates).length > 0) {
      await ctx.db.patch(args.ligneId, ligneUpdates);
    }

    // Si le taux a changé, propage aux saisons suivantes du moniteur.
    if (ligneUpdates.tauxHoraireBrut !== undefined) {
      await cascadeTaux(ctx, args.salarieId, ligne.saison, ligneUpdates.tauxHoraireBrut as number);
    }
  },
});

export const removeSalarie = mutation({
  args: { salarieId: v.id("salaries") },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    // Supprime toutes les lignes de saison liées + l'identité.
    const lignes = await ctx.db
      .query("salairesSaison")
      .withIndex("by_salarie", (q) => q.eq("salarieId", args.salarieId))
      .collect();
    for (const l of lignes) await ctx.db.delete(l._id);
    await ctx.db.delete(args.salarieId);
  },
});

// Reprend (copie) les données de la saison précédente dans `saison` : paramètres
// de paie + lignes de salaire (mêmes moniteurs, mêmes taux/heures, augmentation
// remise à 0). N'agit que si la saison cible est vide.
export const reprendreSaisonPrecedente = mutation({
  args: { saison: v.string() },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");

    const prev = previousSaison(args.saison);
    if (!prev) throw new Error("Saison invalide (format attendu : AAAA-AA).");

    const dejaPresent = await ctx.db
      .query("salairesSaison")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .first();
    if (dejaPresent) {
      return { copiees: 0, message: `Des données existent déjà pour ${args.saison}.` };
    }

    const prevLignes = await ctx.db
      .query("salairesSaison")
      .withIndex("by_saison", (q) => q.eq("saison", prev))
      .collect();
    if (prevLignes.length === 0) {
      throw new Error(`Aucune donnée à reprendre pour la saison ${prev}.`);
    }

    // Paramètres de paie : repris de N-1 (ou défaut si absents).
    const existingParams = await ctx.db
      .query("parametresPaie")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .first();
    if (!existingParams) {
      const prevParams = await ctx.db
        .query("parametresPaie")
        .withIndex("by_saison", (q) => q.eq("saison", prev))
        .first();
      if (prevParams) {
        await ctx.db.insert("parametresPaie", {
          saison: args.saison,
          margeSecurite: prevParams.margeSecurite,
          indemniteCpPct: prevParams.indemniteCpPct,
          mutuelleSalarie: prevParams.mutuelleSalarie,
          mutuelleEmployeur: prevParams.mutuelleEmployeur,
          primeEquipementAnnuelle: prevParams.primeEquipementAnnuelle,
          fraisBulletin: prevParams.fraisBulletin,
          cotisationsSalariales: prevParams.cotisationsSalariales,
          cotisationsPatronales: prevParams.cotisationsPatronales,
        });
      } else {
        await ctx.db.insert("parametresPaie", { saison: args.saison, ...DEFAULT_PARAMS });
      }
    }

    for (const l of prevLignes) {
      await ctx.db.insert("salairesSaison", {
        salarieId: l.salarieId,
        saison: args.saison,
        nbHeuresAnnuel: l.nbHeuresAnnuel,
        nbMois: l.nbMois,
        tauxHoraireBrut: l.tauxHoraireBrut, // 0 % d'augmentation -> taux identique
        augmentationPct: 0,
        actif: l.actif ?? true,
        heuresSup: l.heuresSup ?? [],
      });
    }
    return { copiees: prevLignes.length, message: `${prevLignes.length} moniteurs repris de ${prev}.` };
  },
});

export const updateParametres = mutation({
  args: {
    saison: v.string(),
    margeSecurite: v.number(),
    indemniteCpPct: v.number(),
    mutuelleSalarie: v.number(),
    mutuelleEmployeur: v.number(),
    primeEquipementAnnuelle: v.number(),
    fraisBulletin: v.number(),
    cotisationsSalariales: v.array(cotisSalarialeValidator),
    cotisationsPatronales: v.array(cotisPatronaleValidator),
  },
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "budget");
    const { saison, ...rest } = args;
    const existing = await ctx.db
      .query("parametresPaie")
      .withIndex("by_saison", (q) => q.eq("saison", saison))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, rest);
    } else {
      await ctx.db.insert("parametresPaie", { saison, ...rest });
    }
  },
});
