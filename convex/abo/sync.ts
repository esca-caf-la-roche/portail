// Orchestration des synchronisations externes (HelloAsso + site club) en mode
// ON-DEMAND avec verrou anti-rejeu (throttle) PARTAGÉ côté serveur.
//
// Historique : ces tâches tournaient en crons horaires 24/7 → gros Database I/O
// même quand personne n'utilisait l'appli. On les déclenche désormais au
// chargement des pages qui en ont besoin, mais une source n'est réellement
// resynchronisée qu'au plus une fois par fenêtre (TTL), tous onglets/admins
// confondus, grâce à un marqueur horodaté dans abo_app_config.
//
// Le matching des personnes (scraperAbonnes → matcherScrapPersonnes) calcule
// etape_paiement depuis la colonne Paiement du site club. Les autres sources
// (HelloAsso, annuaire licences, élèves en cours) sont indépendantes.
//
// Les boutons « Synchroniser maintenant » restent câblés sur des actions
// directes. Le site club conserve son délai manuel de 5 min, tandis que
// l'annuaire partage deux créneaux quotidiens à 7 h et 9 h (Europe/Paris).

import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { authenticatedAction, authenticatedQuery } from "../customFunctions";
import { api, internal } from "../_generated/api";
import { requireTile } from "../access";
import { champsModifies } from "../dbUtils";
import {
  ANNUAIRE_ATTEMPT_KEY,
  calculerCreneauAnnuaire,
  AUTOMATIC_SYNC_INTERVALS_MS,
  MANUAL_SYNC_INTERVALS_MS,
  MANUAL_SYNC_LOCK_KEYS,
  CLUB_SYNC_ATTEMPT_KEY,
  CLUB_SYNC_COMPLETE_KEY,
  CLUB_SYNC_MAX_AGE_MS,
  SYNC_SUCCESS_KEYS,
  type SyncSource,
} from "./syncConstants";

import { calculerStatutSource, calculerStatutAnnuaire } from "./syncStatus";

type Source = SyncSource;
type Resultat = "done" | "skipped" | "desactive" | "erreur";
type ResultatEleves = Exclude<Resultat, "desactive">;

const resultatValidator = v.union(
  v.literal("done"),
  v.literal("skipped"),
  v.literal("desactive"),
  v.literal("erreur"),
);
const resultatElevesValidator = v.union(
  v.literal("done"),
  v.literal("skipped"),
  v.literal("erreur"),
);
const sourceValidator = v.union(
  v.literal("helloasso"),
  v.literal("scrap"),
  v.literal("annuaire"),
  v.literal("eleves"),
);

const CLE_MARQUEUR = SYNC_SUCCESS_KEYS;
const TTL_PAR_SOURCE = AUTOMATIC_SYNC_INTERVALS_MS;

// Check-and-set atomique commun à TOUTES les entrées de l'import annuaire.
// Une tentative consomme son créneau même si l'appel externe échoue.
export const reserverSyncAnnuaire = internalMutation({
  args: { generation: v.optional(v.number()) },
  returns: v.object({
    statut: v.union(v.literal("reserved"), v.literal("skipped"), v.literal("desactive")),
    retryAt: v.union(v.string(), v.null()),
    generation: v.number(),
    tentativeAt: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const lire = (cle: string) => ctx.db.query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", cle)).unique();
    const [active, generationRow, tentative, historique] = await Promise.all([
      lire("synchronisation_externe_active"), lire("synchronisation_externe_generation"),
      lire(ANNUAIRE_ATTEMPT_KEY), lire(SYNC_SUCCESS_KEYS.annuaire),
    ]);
    const generation = Number(generationRow?.valeur) || 0;
    if (active?.valeur === "false" || (args.generation !== undefined && args.generation !== generation)) {
      return { statut: "desactive" as const, retryAt: null, generation };
    }
    const now = Date.now();
    const creneau = calculerCreneauAnnuaire(now, tentative?.valeur, historique?.valeur);
    if (!creneau.disponible) {
      return { statut: "skipped" as const, retryAt: creneau.nextSyncAt, generation };
    }
    const valeur = new Date(now).toISOString();
    const patch = { valeur, updated_at: valeur };
    if (tentative) {
      if (champsModifies(tentative, patch)) await ctx.db.patch(tentative._id, patch);
    } else {
      await ctx.db.insert("abo_app_config", { cle: ANNUAIRE_ATTEMPT_KEY, ...patch });
    }
    return { statut: "reserved" as const, retryAt: null, generation, tentativeAt: valeur };
  },
});

// ── reserverSync : check-and-set ATOMIQUE du verrou (une seule mutation) ──
// Si une synchro récente (< ttlMs) existe → proceed=false. Sinon pose le
// marqueur = maintenant AVANT de lancer la synchro (empêche la ruée de deux
// onglets qui passeraient le test en parallèle) et renvoie l'ancienne valeur
// pour pouvoir la restaurer en cas d'échec.
export const reserverSync = internalMutation({
  args: { cle: v.string(), ttlMs: v.number() },
  returns: v.object({
    proceed: v.boolean(),
    precedent: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.ttlMs) || args.ttlMs <= 0) {
      throw new ConvexError({ code: "22023", message: "Durée de synchronisation invalide." });
    }
    const now = Date.now();
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", args.cle))
      .first();
    const precedent = row?.valeur;
    const lastMs = precedent ? Date.parse(precedent) : NaN;
    if (Number.isFinite(lastMs) && now - lastMs < args.ttlMs) {
      return { proceed: false, precedent };
    }
    const valeur = new Date(now).toISOString();
    if (row) {
      await ctx.db.patch(row._id, { valeur, updated_at: valeur });
    } else {
      await ctx.db.insert("abo_app_config", { cle: args.cle, valeur, updated_at: valeur });
    }
    return { proceed: true, precedent };
  },
});

// Réservation propre à la synchronisation complète du site club. Le verrou
// `last_sync_scrap` reste partagé avec les synchronisations existantes, tandis
// que la clé de complétion n'est posée qu'après abonnés + élèves. Un verrou
// récent sans complétion correspond donc sans ambiguïté à une tentative en
// cours ou échouée, jamais à un snapshot exploitable.
export const reserverSyncClub = internalMutation({
  args: { ttlMs: v.number() },
  returns: v.object({
    proceed: v.boolean(),
    complete: v.boolean(),
    precedent: v.optional(v.string()),
    tentativeAt: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.ttlMs) || args.ttlMs <= 0) {
      throw new ConvexError({
        code: "22023",
        message: "Durée de synchronisation invalide.",
      });
    }
    const [verrou, tentative, completion] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", MANUAL_SYNC_LOCK_KEYS.scrap))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_ATTEMPT_KEY))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_COMPLETE_KEY))
        .unique(),
    ]);
    const precedent = verrou?.valeur;
    const lastMs = precedent ? Date.parse(precedent) : NaN;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < args.ttlMs) {
      return {
        proceed: false,
        complete:
          tentative?.valeur !== undefined &&
          tentative.valeur === precedent &&
          completion?.valeur === tentative.valeur,
        precedent,
      };
    }

    const tentativeAt = new Date().toISOString();
    const patch = { valeur: tentativeAt, updated_at: tentativeAt };
    if (verrou) {
      await ctx.db.patch(verrou._id, patch);
    } else {
      await ctx.db.insert("abo_app_config", {
        cle: MANUAL_SYNC_LOCK_KEYS.scrap,
        ...patch,
      });
    }
    const tentativeExistante = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_ATTEMPT_KEY))
      .unique();
    if (tentativeExistante) {
      await ctx.db.patch(tentativeExistante._id, patch);
    } else {
      await ctx.db.insert("abo_app_config", {
        cle: CLUB_SYNC_ATTEMPT_KEY,
        ...patch,
      });
    }
    return {
      proceed: true,
      complete: false,
      precedent,
      tentativeAt,
    };
  },
});

export const marquerSyncClubComplete = internalMutation({
  args: { tentativeAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [verrou, tentative] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", MANUAL_SYNC_LOCK_KEYS.scrap))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_ATTEMPT_KEY))
        .unique(),
    ]);
    if (
      verrou?.valeur !== args.tentativeAt ||
      tentative?.valeur !== args.tentativeAt
    ) {
      throw new ConvexError({
        code: "ABO_SYNC_CLUB_REMPLACEE",
        message: "Cette synchronisation a été remplacée par une tentative plus récente.",
      });
    }
    const completion = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_COMPLETE_KEY))
      .unique();
    const patch = { valeur: args.tentativeAt, updated_at: args.tentativeAt };
    if (completion) {
      if (champsModifies(completion, patch)) {
        await ctx.db.patch(completion._id, patch);
      }
    } else {
      await ctx.db.insert("abo_app_config", {
        cle: CLUB_SYNC_COMPLETE_KEY,
        ...patch,
      });
    }
    await ctx.scheduler.runAfter(
      CLUB_SYNC_MAX_AGE_MS,
      internal.abo.sync.expirerSyncClubComplete,
      { tentativeAt: args.tentativeAt },
    );
    return null;
  },
});

export const expirerSyncClubComplete = internalMutation({
  args: { tentativeAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const completion = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_COMPLETE_KEY))
      .unique();
    if (completion?.valeur === args.tentativeAt) {
      await ctx.db.patch(completion._id, {
        valeur: undefined,
        updated_at: new Date().toISOString(),
      });
    }
    return null;
  },
});

export const etatSyncClubInterne = internalQuery({
  args: {},
  returns: v.object({
    active: v.boolean(),
    verrouAt: v.union(v.string(), v.null()),
    complete: v.boolean(),
  }),
  handler: async (ctx) => {
    const [active, verrou, tentative, completion] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) =>
          q.eq("cle", "synchronisation_externe_active"),
        )
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", MANUAL_SYNC_LOCK_KEYS.scrap))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_ATTEMPT_KEY))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLUB_SYNC_COMPLETE_KEY))
        .unique(),
    ]);
    return {
      active: active?.valeur !== "false",
      verrouAt: verrou?.valeur ?? null,
      complete:
        tentative?.valeur !== undefined &&
        verrou?.valeur === tentative.valeur &&
        completion?.valeur === tentative.valeur,
    };
  },
});

// ── restaurerMarqueur : remet l'ancienne valeur si la synchro échoue ──
// Ainsi un échec ne « consomme » pas la fenêtre : le prochain chargement
// réessaiera. Valeur absente (jamais synchronisé) → on vide le marqueur.
export const restaurerMarqueur = internalMutation({
  args: { cle: v.string(), valeur: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", args.cle))
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        valeur: args.valeur ?? undefined,
        updated_at: new Date().toISOString(),
      });
    } else if (args.valeur !== undefined) {
      await ctx.db.insert("abo_app_config", { cle: args.cle, valeur: args.valeur });
    }
    return null;
  },
});

// Restauration CAS pour une orchestration longue : une exécution ancienne ne
// peut pas remettre son marqueur si une tentative plus récente a déjà repris
// le verrou partagé.
export const restaurerMarqueurSiTentativeCourante = internalMutation({
  args: {
    cle: v.string(),
    tentativeAt: v.string(),
    valeur: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", args.cle))
      .unique();
    if (row?.valeur !== args.tentativeAt) return false;
    await ctx.db.patch(row._id, {
      valeur: args.valeur ?? undefined,
      updated_at: new Date().toISOString(),
    });
    return true;
  },
});

// ── synchroniserSource : lance UNE source si le verrou l'autorise ──
// Ne jette jamais : renvoie un statut pour que la page reste fonctionnelle même
// si une source externe est indisponible.
function synchroniserSource(
  ctx: ActionCtx,
  source: "eleves",
  contexteAbo: true,
): Promise<Resultat>;
function synchroniserSource(
  ctx: ActionCtx,
  source: "eleves",
  contexteAbo?: false,
): Promise<ResultatEleves>;
function synchroniserSource(
  ctx: ActionCtx,
  source: Exclude<Source, "eleves">,
  contexteAbo?: boolean,
): Promise<Resultat>;
async function synchroniserSource(
  ctx: ActionCtx,
  source: Source,
  contexteAbo = false,
): Promise<Resultat> {
  if (source === "annuaire") {
    try {
      const resultat = await ctx.runAction(internal.abo.licences.importerAnnuaireLicencesInternal, {});
      return resultat.statut;
    } catch (e) {
      console.error("[sync] échec source annuaire:", e);
      return "erreur";
    }
  }
  const etat = (source === "scrap" || (source === "eleves" && contexteAbo))
    ? await ctx.runQuery(internal.abo.config.etatSynchronisationExterneInterne, {})
    : null;
  if (etat && !etat.active) return "desactive";
  const cle = CLE_MARQUEUR[source];
  const reservation = await ctx.runMutation(internal.abo.sync.reserverSync, {
    cle,
    ttlMs: TTL_PAR_SOURCE[source],
  });
  if (!reservation.proceed) return "skipped";
  try {
    switch (source) {
      case "helloasso":
        await ctx.runAction(internal.helloasso.syncHelloAssoInternal, {});
        break;
      case "scrap":
        await ctx.runAction(internal.abo.scrap.scraperAbonnes, { generation: etat!.generation });
        break;
      case "eleves":
        await ctx.runAction(internal.abo.scrap.importerElevesEnCours, {
          contexteAbo,
        });
        break;
    }
    return "done";
  } catch (e) {
    await ctx.runMutation(internal.abo.sync.restaurerMarqueur, {
      cle,
      valeur: reservation.precedent,
    });
    console.error(`[sync] échec source ${source}:`, e);
    return "erreur";
  }
}

// ── syncPourPaiements : page Validation des paiements cours (staff connecté) ──
export const syncPourPaiements = authenticatedAction({
  args: {},
  returns: v.object({ helloasso: resultatValidator }),
  handler: async (ctx): Promise<{ helloasso: Resultat }> => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "paiements",
    });
    return { helloasso: await synchroniserSource(ctx, "helloasso") };
  },
});

// ── syncPourAbo : espace admin abonnements (compteur, anomalies, dossiers…) ──
// HelloAsso, puis site club (+ matching), annuaire et élèves.
export const syncPourAbo = authenticatedAction({
  args: {},
  returns: v.object({
    helloasso: resultatValidator,
    scrap: resultatValidator,
    annuaire: resultatValidator,
    eleves: resultatValidator,
  }),
  handler: async (
    ctx,
  ): Promise<{ helloasso: Resultat; scrap: Resultat; annuaire: Resultat; eleves: Resultat }> => {
    const me = await ctx.runQuery(api.abo.identity.me, {});
    if (!me || me.aboRole !== "admin") {
      throw new ConvexError({ code: "42501", message: "Réservé aux administrateurs." });
    }
    const helloasso = await synchroniserSource(ctx, "helloasso");
    const scrap = await synchroniserSource(ctx, "scrap");
    const annuaire = await synchroniserSource(ctx, "annuaire");
    const eleves = await synchroniserSource(ctx, "eleves", true);
    return { helloasso, scrap, annuaire, eleves };
  },
});

// ── syncPourLicencesCours : tuile « licences élèves en cours » (staff dédié) ──
export const syncPourLicencesCours = authenticatedAction({
  args: {},
  returns: v.object({
    annuaire: resultatValidator,
    eleves: resultatElevesValidator,
  }),
  handler: async (ctx): Promise<{ annuaire: Resultat; eleves: ResultatEleves }> => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "licences_cours",
    });
    // Le snapshot des élèves est la source de vérité de la liste. On le met à
    // jour avant l'annuaire afin qu'une licence désormais renseignée efface
    // immédiatement tout traitement manuel devenu obsolète.
    const eleves = await synchroniserSource(ctx, "eleves");
    const annuaire = await synchroniserSource(ctx, "annuaire");
    return { annuaire, eleves };
  },
});

const statutSourceValidator = v.object({
  lastSyncAt: v.union(v.string(), v.null()),
  nextSyncAt: v.union(v.string(), v.null()),
  lastAttemptAt: v.optional(v.union(v.string(), v.null())),
  minimumIntervalMs: v.optional(v.number()),
});

const statutSourceAboValidator = statutSourceValidator.extend({
  active: v.boolean(),
  minimumIntervalMs: v.number(),
  manualNextSyncAt: v.union(v.string(), v.null()),
  manualIntervalMs: v.union(v.number(), v.null()),
});

// ── getStatutSyncAbo : synthèse des sources de l'espace admin Abonnements ──
// Les clients actuels calculent le temps restant localement depuis les échéances.
// Argument temporel conservé uniquement pour les anciens clients.
export const getStatutSyncAbo = authenticatedQuery({
  args: { maintenantMs: v.optional(v.number()) },
  returns: v.object({
    helloasso: statutSourceAboValidator,
    scrap: statutSourceAboValidator,
    annuaire: statutSourceAboValidator,
    eleves: statutSourceAboValidator,
  }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "abonnements");
    if (args.maintenantMs !== undefined && !Number.isFinite(args.maintenantMs)) {
      throw new ConvexError({ code: "22023", message: "Date de consultation invalide." });
    }

    const [helloasso, scrap, annuaire, eleves, verrouManuelHelloasso, synchronisationExterne, tentativeAnnuaire] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.helloasso))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.scrap))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.annuaire))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.eleves))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", MANUAL_SYNC_LOCK_KEYS.helloasso))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", "synchronisation_externe_active"))
        .unique(),
      ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", ANNUAIRE_ATTEMPT_KEY)).unique(),
    ]);
    const synchronisationExterneActive = synchronisationExterne?.valeur !== "false";
    const statut = (
      source: Source,
      valeur: string | undefined,
      valeurVerrouManuel: string | undefined,
      active: boolean,
    ) => ({
      active,
      minimumIntervalMs: TTL_PAR_SOURCE[source],
      ...calculerStatutSource(valeur, TTL_PAR_SOURCE[source], args.maintenantMs),
      manualNextSyncAt: calculerStatutSource(
        valeurVerrouManuel,
        MANUAL_SYNC_INTERVALS_MS[source],
        args.maintenantMs,
      ).nextSyncAt,
      manualIntervalMs: MANUAL_SYNC_INTERVALS_MS[source],
    });

    return {
      helloasso: statut("helloasso", helloasso?.valeur, verrouManuelHelloasso?.valeur, true),
      scrap: statut("scrap", scrap?.valeur, scrap?.valeur, synchronisationExterneActive),
      annuaire: {
        active: synchronisationExterneActive,
        minimumIntervalMs: 0,
        ...calculerStatutAnnuaire(annuaire?.valeur, tentativeAnnuaire?.valeur, args.maintenantMs),
        manualNextSyncAt: calculerStatutAnnuaire(annuaire?.valeur, tentativeAnnuaire?.valeur, args.maintenantMs).nextSyncAt,
        manualIntervalMs: 0,
      },
      eleves: statut("eleves", eleves?.valeur, scrap?.valeur, synchronisationExterneActive),
    };
  },
});

// Enregistre l'instant canonique de réussite après le retour de la source.
// L'instant est fourni par l'action afin qu'un rejeu avec la même valeur soit
// strictement idempotent et n'invalide pas les abonnements temps réel.
export const marquerSyncReussie = internalMutation({
  args: { source: sourceValidator, reussieAt: v.string(), annuaireTentativeAt: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.source === "annuaire" && args.annuaireTentativeAt !== undefined) {
      const tentative = await ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", ANNUAIRE_ATTEMPT_KEY)).unique();
      if (tentative?.valeur !== args.annuaireTentativeAt) {
        throw new ConvexError("Synchronisation annuaire remplacée par un créneau plus récent.");
      }
    }
    const reussieMs = Date.parse(args.reussieAt);
    if (!Number.isFinite(reussieMs)) {
      throw new ConvexError({ code: "22023", message: "Date de synchronisation invalide." });
    }
    const valeur = new Date(reussieMs).toISOString();
    const cle = SYNC_SUCCESS_KEYS[args.source];
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", cle))
      .unique();
    const patch = { valeur, updated_at: valeur };
    if (row) {
      if (champsModifies(row, patch)) {
        await ctx.db.patch(row._id, patch);
      }
    } else {
      await ctx.db.insert("abo_app_config", { cle, ...patch });
    }
    return null;
  },
});

export const getStatutSyncLicencesCours = authenticatedQuery({
  // Optionnel pour conserver la compatibilité avec les clients déjà déployés.
  // Les nouveaux clients utilisent les échéances absolues et leur horloge locale.
  args: { maintenantMs: v.optional(v.number()) },
  returns: v.object({
    eleves: statutSourceValidator,
    annuaire: statutSourceValidator,
  }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "licences_cours");
    if (args.maintenantMs !== undefined && !Number.isFinite(args.maintenantMs)) {
      throw new ConvexError({ code: "22023", message: "Date de consultation invalide." });
    }
    const [eleves, annuaire, tentativeAnnuaire] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.eleves))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.annuaire))
        .unique(),
      ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", ANNUAIRE_ATTEMPT_KEY)).unique(),
    ]);

    return {
      eleves: {
        ...calculerStatutSource(eleves?.valeur, TTL_PAR_SOURCE.eleves, args.maintenantMs),
        minimumIntervalMs: TTL_PAR_SOURCE.eleves,
      },
      annuaire: calculerStatutAnnuaire(
        annuaire?.valeur,
        tentativeAnnuaire?.valeur,
        args.maintenantMs,
      ),
    };
  },
});

// ── syncPourContactsCours : tuile « contacts des élèves en cours » ────────
// La garde est exécutée dans une internalQuery car une action n'a pas accès à
// ctx.db. Cette tuile ne dépend que du snapshot des élèves.
export const syncPourContactsCours = authenticatedAction({
  args: {},
  returns: v.object({
    eleves: resultatElevesValidator,
  }),
  handler: async (ctx): Promise<{ eleves: ResultatEleves }> => {
    await ctx.runQuery(internal.contactsCours.requireContactsCoursAccess, {
      userId: ctx.userId,
    });
    // La source élèves n'est jamais concernée par la pause scrap/annuaire.
    return { eleves: await synchroniserSource(ctx, "eleves") };
  },
});
