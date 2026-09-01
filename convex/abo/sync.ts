// Orchestration des synchronisations externes (HelloAsso + site club) en mode
// ON-DEMAND avec verrou anti-rejeu (throttle) PARTAGÉ côté serveur.
//
// Historique : ces tâches tournaient en crons horaires 24/7 → gros Database I/O
// même quand personne n'utilisait l'appli. On les déclenche désormais au
// chargement des pages qui en ont besoin, mais une source n'est réellement
// resynchronisée qu'au plus une fois par fenêtre (TTL), tous onglets/admins
// confondus, grâce à un marqueur horodaté dans abo_app_config.
//
// ORDRE DES DÉPENDANCES : HelloAsso AVANT le scrap — le matching des personnes
// (scraperAbonnes → matcherScrapPersonnes) calcule etape_paiement depuis les
// transactions HelloAsso. Les autres sources (annuaire licences, élèves en
// cours) sont indépendantes et peuvent suivre dans n'importe quel ordre.
//
// Les boutons « Synchroniser maintenant » restent câblés sur des actions
// directes. Le site club conserve son délai manuel de 5 min, tandis que
// l'annuaire reste volontairement soumis au verrou partagé de 12 h.

import { v, ConvexError } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { authenticatedAction, authenticatedQuery } from "../customFunctions";
import { api, internal } from "../_generated/api";
import { requireTile } from "../access";
import { champsModifies } from "../dbUtils";
import {
  AUTOMATIC_SYNC_INTERVALS_MS,
  MANUAL_SYNC_INTERVALS_MS,
  MANUAL_SYNC_LOCK_KEYS,
  SYNC_SUCCESS_KEYS,
  type SyncSource,
} from "./syncConstants";

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
  const etat = (source === "scrap" || source === "annuaire" || (source === "eleves" && contexteAbo))
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
      case "annuaire":
        await ctx.runAction(internal.abo.licences.importerAnnuaireLicencesInternal, { generation: etat!.generation });
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
// HelloAsso d'abord (etape_paiement), puis scrap(+matching), annuaire, élèves.
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
});

const statutSourceAboValidator = statutSourceValidator.extend({
  active: v.boolean(),
  minimumIntervalMs: v.number(),
  manualNextSyncAt: v.union(v.string(), v.null()),
  manualIntervalMs: v.union(v.number(), v.null()),
});

function calculerStatutSource(
  valeur: string | undefined,
  ttlMs: number,
  maintenantMs?: number,
) {
  const lastMs = valeur ? Date.parse(valeur) : NaN;
  const prochaineMs = lastMs + ttlMs;
  return {
    lastSyncAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    nextSyncAt: Number.isFinite(prochaineMs)
      && (maintenantMs === undefined || prochaineMs > maintenantMs)
      ? new Date(prochaineMs).toISOString()
      : null,
  };
}

// ── getStatutSyncAbo : synthèse des sources de l'espace admin Abonnements ──
// `maintenantMs` est stabilisé côté client (arrondi à la minute) : une query
// Convex ne doit pas lire l'horloge, car le passage du temps seul ne la réexécute pas.
export const getStatutSyncAbo = authenticatedQuery({
  args: { maintenantMs: v.number() },
  returns: v.object({
    helloasso: statutSourceAboValidator,
    scrap: statutSourceAboValidator,
    annuaire: statutSourceAboValidator,
    eleves: statutSourceAboValidator,
  }),
  handler: async (ctx, args) => {
    await requireTile(ctx, ctx.userId, "abonnements");
    if (!Number.isFinite(args.maintenantMs)) {
      throw new ConvexError({ code: "22023", message: "Date de consultation invalide." });
    }

    const [helloasso, scrap, annuaire, eleves, verrouManuelHelloasso, synchronisationExterne] = await Promise.all([
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
      annuaire: statut("annuaire", annuaire?.valeur, annuaire?.valeur, synchronisationExterneActive),
      eleves: statut("eleves", eleves?.valeur, scrap?.valeur, synchronisationExterneActive),
    };
  },
});

// Enregistre l'instant canonique de réussite après le retour de la source.
// L'instant est fourni par l'action afin qu'un rejeu avec la même valeur soit
// strictement idempotent et n'invalide pas les abonnements temps réel.
export const marquerSyncReussie = internalMutation({
  args: { source: sourceValidator, reussieAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
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
  // Les nouveaux clients le fournissent afin de masquer une échéance déjà passée.
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
    const [eleves, annuaire] = await Promise.all([
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.eleves))
        .unique(),
      ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", CLE_MARQUEUR.annuaire))
        .unique(),
    ]);

    return {
      eleves: calculerStatutSource(
        eleves?.valeur,
        TTL_PAR_SOURCE.eleves,
        args.maintenantMs,
      ),
      annuaire: calculerStatutSource(
        annuaire?.valeur,
        TTL_PAR_SOURCE.annuaire,
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
