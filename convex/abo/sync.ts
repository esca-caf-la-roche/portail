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
import { authenticatedAction } from "../customFunctions";
import { api, internal } from "../_generated/api";

// Fenêtre anti-rejeu par défaut (60 min). L'annuaire des licences est plus
// coûteux et change peu : 12 h entre deux imports garantit au plus deux
// exécutions sur une fenêtre glissante de 24 h.
const TTL_MS = (Number(process.env.SYNC_TTL_MINUTES) || 60) * 60_000;
const TTL_ANNUAIRE_MS = 12 * 60 * 60_000;

type Source = "helloasso" | "scrap" | "annuaire" | "eleves";
type Resultat = "done" | "skipped" | "erreur";

const CLE_MARQUEUR: Record<Source, string> = {
  helloasso: "last_sync_helloasso",
  scrap: "last_sync_scrap",
  annuaire: "last_sync_annuaire",
  eleves: "last_sync_eleves",
};

const TTL_PAR_SOURCE: Record<Source, number> = {
  helloasso: TTL_MS,
  scrap: TTL_MS,
  annuaire: TTL_ANNUAIRE_MS,
  eleves: TTL_MS,
};

// ── reserverSync : check-and-set ATOMIQUE du verrou (une seule mutation) ──
// Si une synchro récente (< ttlMs) existe → proceed=false. Sinon pose le
// marqueur = maintenant AVANT de lancer la synchro (empêche la ruée de deux
// onglets qui passeraient le test en parallèle) et renvoie l'ancienne valeur
// pour pouvoir la restaurer en cas d'échec.
export const reserverSync = internalMutation({
  args: { cle: v.string(), ttlMs: v.number() },
  handler: async (ctx, args) => {
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
  },
});

// ── synchroniserSource : lance UNE source si le verrou l'autorise ──
// Ne jette jamais : renvoie un statut pour que la page reste fonctionnelle même
// si une source externe est indisponible.
async function synchroniserSource(ctx: ActionCtx, source: Source): Promise<Resultat> {
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
        await ctx.runAction(internal.abo.scrap.scraperAbonnes, {});
        break;
      case "annuaire":
        await ctx.runAction(internal.abo.licences.importerAnnuaireLicencesInternal, {});
        break;
      case "eleves":
        await ctx.runAction(internal.abo.scrap.importerElevesEnCours, {});
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
    const eleves = await synchroniserSource(ctx, "eleves");
    return { helloasso, scrap, annuaire, eleves };
  },
});

// ── syncPourLicencesCours : tuile « licences élèves en cours » (staff dédié) ──
export const syncPourLicencesCours = authenticatedAction({
  args: {},
  handler: async (ctx): Promise<{ annuaire: Resultat; eleves: Resultat }> => {
    const settings = await ctx.runQuery(api.users.getCurrentUserSettings, {});
    if (!settings.allowedTiles?.includes("licences_cours")) {
      throw new ConvexError({
        code: "42501",
        message: "Accès refusé : ce module ne vous est pas attribué.",
      });
    }
    const annuaire = await synchroniserSource(ctx, "annuaire");
    const eleves = await synchroniserSource(ctx, "eleves");
    return { annuaire, eleves };
  },
});

// ── syncPourContactsCours : tuile « contacts des élèves en cours » ────────
// La garde est exécutée dans une internalQuery car une action n'a pas accès à
// ctx.db. Cette tuile ne dépend que du snapshot des élèves.
export const syncPourContactsCours = authenticatedAction({
  args: {},
  returns: v.object({
    eleves: v.union(v.literal("done"), v.literal("skipped"), v.literal("erreur")),
  }),
  handler: async (ctx): Promise<{ eleves: Resultat }> => {
    await ctx.runQuery(internal.contactsCours.requireContactsCoursAccess, {
      userId: ctx.userId,
    });
    return { eleves: await synchroniserSource(ctx, "eleves") };
  },
});
