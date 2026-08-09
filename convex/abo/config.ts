// Configuration applicative du module Abonnements (table abo_app_config) et
// helpers du gating par vague. Portage de :
//   - gating_helpers.sql (vagues_config, licence_est_eleve)
//   - vagues_timezone.sql (vague_courante + interprétation Europe/Paris)
//   - liens_finalisation.sql (liens_finalisation)
//
// Les dates de vagues sont saisies via <input datetime-local> → une heure LOCALE
// naïve « YYYY-MM-DDTHH:mm » (heure de Paris), stockée telle quelle. À la lecture
// on l'interprète comme une heure d'Europe/Paris (gère l'heure d'été/hiver) pour
// la comparer à « maintenant », exactement comme le faisait Postgres.

import { ConvexError, v } from "convex/values";
import { authenticatedQuery, authenticatedMutation } from "../customFunctions";
import { internalMutation } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAboAdmin, requireAboSeasonReset } from "./auth";
import { parseHa, poserLienAbo, trouverLienAbo } from "./paiements";
import { REGLEMENT_DOCUSEAL_URL } from "./reglementsConstants";

const MAX_REDIRECTIONS_PAR_CAMPAGNE = 1_000;

// ── Lecture d'une clé de config ──────────────────────────────────────
export async function getConfigValeur(
  ctx: QueryCtx | MutationCtx,
  cle: string,
): Promise<string | null> {
  const row = await ctx.db
    .query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", cle))
    .first();
  const val = row?.valeur ?? null;
  return val && val.trim() !== "" ? val : null;
}

// ── Fuseau Europe/Paris : instant UTC d'une heure murale naïve ───────
// Offset (ms) d'Europe/Paris à un instant UTC donné, via Intl (gère la DST).
function parisOffsetMs(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // certains runtimes rendent 24 pour minuit
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asIfUtc - utcMs;
}

// Convertit « YYYY-MM-DDTHH:mm » (heure de Paris) en instant UTC (ms), ou null.
export function parisWallToUtcMs(naive?: string | null): number | null {
  if (!naive) return null;
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  const asUtc = Date.UTC(Y, Mo - 1, D, H, Mi);
  // wall = utc + offset  ⇒  utc = wall - offset. On affine une fois pour les
  // bascules d'heure d'été (l'offset dépend de l'instant).
  const off1 = parisOffsetMs(asUtc);
  let utc = asUtc - off1;
  const off2 = parisOffsetMs(utc);
  if (off2 !== off1) utc = asUtc - off2;
  return utc;
}

// Date ISO (UTC) d'une clé de date de vague, ou null. Sert au front pour
// afficher « la demande ouvrira le … » (via toLocaleString côté navigateur).
async function vagueDateIso(
  ctx: QueryCtx | MutationCtx,
  cle: string,
): Promise<string | null> {
  const utc = parisWallToUtcMs(await getConfigValeur(ctx, cle));
  return utc == null ? null : new Date(utc).toISOString();
}

function urlHttps(valeur: string): URL | null {
  try {
    const url = new URL(valeur.trim());
    return url.protocol === "https:" && url.hostname ? url : null;
  } catch {
    return null;
  }
}

function estDomaineInscriptionOfficiel(hostname: string): boolean {
  const domaine = hostname.toLowerCase();
  return (
    domaine === "caflarochebonneville.fr" ||
    domaine.endsWith(".caflarochebonneville.fr")
  );
}

function lienInscriptionPublic(valeur: string | null): string | null {
  if (!valeur) return null;
  const url = urlHttps(valeur);
  return url && estDomaineInscriptionOfficiel(url.hostname)
    ? valeur.trim()
    : null;
}

// Instant limite figÃ© pour une personne dÃ©posÃ©e pendant la vague 2. Ne pas
// relire cette configuration lors d'une dÃ©cision : la personne garde sa copie.
// ── vague_courante() : numéro de vague (0/1/2/3) selon l'instant présent ──
export async function vagueCourante(
  ctx: QueryCtx | MutationCtx,
  maintenantMs: number,
): Promise<number> {
  const v1 = parisWallToUtcMs(await getConfigValeur(ctx, "vague1_debut"));
  const v2 = parisWallToUtcMs(await getConfigValeur(ctx, "vague2_debut"));
  const v3 = parisWallToUtcMs(await getConfigValeur(ctx, "vague3_debut"));
  if (v3 != null && maintenantMs >= v3) return 3;
  if (v2 != null && maintenantMs >= v2) return 2;
  if (v1 != null && maintenantMs >= v1) return 1;
  return 0;
}

// ── vagues_config() : calendrier (vague courante + 3 dates) pour le front ──
// Non nominatif. Réservé aux comptes connectés (l'espace abo exige une connexion
// OTP) — satisfait la règle de sécurité authenticatedQuery.
export const vaguesConfig = authenticatedQuery({
  args: { maintenantMs: v.number() },
  returns: v.object({
    vague: v.number(),
    vague1_debut: v.union(v.string(), v.null()),
    vague2_debut: v.union(v.string(), v.null()),
    vague3_debut: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    return {
      vague: await vagueCourante(ctx, args.maintenantMs),
      vague1_debut: await vagueDateIso(ctx, "vague1_debut"),
      vague2_debut: await vagueDateIso(ctx, "vague2_debut"),
      vague3_debut: await vagueDateIso(ctx, "vague3_debut"),
    };
  },
});

// ── licence_est_eleve(licence) : booléen sans fuite (contrôle vague 2) ──
// Vrai si la licence appartient à un élève en cours d'escalade (passe-droit
// vague 2). Ne renvoie JAMAIS la liste des élèves (booléen seul).
export const licenceEstEleve = authenticatedQuery({
  args: { licence: v.string() },
  handler: async (ctx, args) => {
    const lic = args.licence.trim();
    if (!lic) return false;
    const row = await ctx.db
      .query("abo_eleves_en_cours")
      .withIndex("by_licence", (q) => q.eq("licence", lic))
      .first();
    return row !== null;
  },
});

// ── liens_finalisation() : liens des étapes de finalisation (page de suivi) ──
// Non nominatif ; exposé aux comptes connectés. abo_app_config n'est lisible que
// par l'admin ; ici on n'expose QUE les liens.
export const liensFinalisation = authenticatedQuery({
  args: {},
  returns: v.object({
    licence_nouvelle: v.union(v.string(), v.null()),
    licence_renouvellement: v.union(v.string(), v.null()),
    compte_activation: v.union(v.string(), v.null()),
    inscription: v.union(v.string(), v.null()),
    helloasso: v.union(v.string(), v.null()),
    test_autonomie: v.union(v.string(), v.null()),
    reglement: v.string(),
  }),
  handler: async (ctx) => {
    const inscription = await getConfigValeur(ctx, "inscription_lien");
    return {
      licence_nouvelle: await getConfigValeur(ctx, "licence_lien_nouvelle"),
      licence_renouvellement: await getConfigValeur(ctx, "licence_lien_renouvellement"),
      compte_activation: await getConfigValeur(ctx, "compte_activation_lien"),
      inscription: lienInscriptionPublic(inscription),
      helloasso: await getConfigValeur(ctx, "helloasso_lien"),
      test_autonomie: await getConfigValeur(ctx, "test_autonomie_lien"),
      reglement: REGLEMENT_DOCUSEAL_URL,
    };
  },
});

// ── Phase I : page admin Configuration + reset de saison ─────────────────

// Upsert d'une clé de config (valeur null → efface le champ). abo_app_config
// n'est jamais lisible directement côté utilisateur (admin-only ici).
async function setConfigValeur(
  ctx: MutationCtx,
  cle: string,
  valeur: string | null,
): Promise<void> {
  const row = await ctx.db
    .query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", cle))
    .first();
  const patch = { valeur: valeur ?? undefined, updated_at: new Date().toISOString() };
  if (row) {
    await ctx.db.patch(row._id, patch);
  } else {
    await ctx.db.insert("abo_app_config", { cle, ...patch });
  }
}

// getConfig() : toutes les clés éditables (admin). Renvoie les valeurs BRUTES
// (les dates de vagues restent au format datetime-local « YYYY-MM-DDTHH:mm »).
const CLES_CONFIG = [
  "helloasso_lien",
  "places_max",
  "licence_lien_nouvelle",
  "licence_lien_renouvellement",
  "compte_activation_lien",
  "inscription_lien",
  "test_autonomie_lien",
  "vague1_debut",
  "vague2_debut",
  "vague3_debut",
] as const;

export const getConfig = authenticatedQuery({
  args: {},
  returns: v.object({
    helloasso_lien: v.union(v.string(), v.null()),
    places_max: v.union(v.string(), v.null()),
    licence_lien_nouvelle: v.union(v.string(), v.null()),
    licence_lien_renouvellement: v.union(v.string(), v.null()),
    compte_activation_lien: v.union(v.string(), v.null()),
    inscription_lien: v.union(v.string(), v.null()),
    test_autonomie_lien: v.union(v.string(), v.null()),
    vague1_debut: v.union(v.string(), v.null()),
    vague2_debut: v.union(v.string(), v.null()),
    vague3_debut: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const [
      helloasso_lien,
      places_max,
      licence_lien_nouvelle,
      licence_lien_renouvellement,
      compte_activation_lien,
      inscription_lien,
      test_autonomie_lien,
      vague1_debut,
      vague2_debut,
      vague3_debut,
    ] = await Promise.all(CLES_CONFIG.map((cle) => getConfigValeur(ctx, cle)));
    return {
      helloasso_lien,
      places_max,
      licence_lien_nouvelle,
      licence_lien_renouvellement,
      compte_activation_lien,
      inscription_lien,
      test_autonomie_lien,
      vague1_debut,
      vague2_debut,
      vague3_debut,
    };
  },
});

// setVagues() : dates d'ouverture des vagues 2 et 3 (admin). La vague 1 n'est
// plus pilotée (réinscription directe sur le site club). Cohérence v2 < v3.
export const setVagues = authenticatedMutation({
  args: {
    vague2_debut: v.optional(v.string()),
    vague3_debut: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const v2 = (args.vague2_debut ?? "").trim() || null;
    const v3 = (args.vague3_debut ?? "").trim() || null;
    if (v2 && v3 && v3 <= v2) {
      throw new Error("Les dates doivent être croissantes : vague 2 < vague 3.");
    }
    await setConfigValeur(ctx, "vague2_debut", v2);
    await setConfigValeur(ctx, "vague3_debut", v3);
    return null;
  },
});

// setLiens() : liens STABLES des étapes de finalisation (admin). Le lien de
// paiement (helloasso_lien) se change au changement de saison, PAS ici.
export const setLiens = authenticatedMutation({
  args: {
    licence_nouvelle: v.optional(v.string()),
    licence_renouvellement: v.optional(v.string()),
    compte_activation: v.optional(v.string()),
    inscription: v.optional(v.string()),
    test_autonomie: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const map: Record<string, string | undefined> = {
      licence_lien_nouvelle: args.licence_nouvelle,
      licence_lien_renouvellement: args.licence_renouvellement,
      compte_activation_lien: args.compte_activation,
      inscription_lien: args.inscription,
      test_autonomie_lien: args.test_autonomie,
    };
    // On ne touche QUE les clés fournies (undefined = laisser inchangé).
    for (const [cle, val] of Object.entries(map)) {
      if (val === undefined) continue;
      const lien = val.trim();
      if (lien) {
        const url = urlHttps(lien);
        if (!url) {
          throw new ConvexError({
            code: "ABO_LIEN_INVALIDE",
            message: "Chaque lien doit être une URL HTTPS absolue.",
          });
        }
        if (
          cle === "inscription_lien" &&
          !estDomaineInscriptionOfficiel(url.hostname)
        ) {
          throw new ConvexError({
            code: "ABO_LIEN_INSCRIPTION_DOMAINE",
            message: "Le lien d'inscription doit utiliser le domaine caflarochebonneville.fr.",
          });
        }
      }
      await setConfigValeur(ctx, cle, lien || null);
    }
    return null;
  },
});

// resetSaison() : changement de saison (admin, portage de reset_saison()).
// Archive N-1, vide l'année en cours (scrap, élèves, cache paiements du lien
// abo, créneaux/réservations de test, email_log), pose le nouveau lien HelloAsso,
// réinitialise les dates de vagues, PUIS programme la purge des comptes publics
// (+ cascade) par lots. `abo_tests_autonomie_archive` reste volontairement
// intact : c'est l'archive permanente des scans, sans lien vers les dossiers.
// Les comptes staff/admin sont CONSERVÉS. 🔒
export const resetSaison = authenticatedMutation({
  args: { saisonArchivee: v.string(), nouveauLien: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireAboSeasonReset(ctx);
    const saison = args.saisonArchivee.trim();
    const lien = args.nouveauLien.trim();
    if (!saison) throw new Error("Libellé de la saison à archiver requis.");
    if (!lien) throw new Error("Nouveau lien HelloAsso requis.");
    if (!parseHa(lien)) {
      throw new Error(
        "Lien HelloAsso non reconnu (attendu : .../associations/<org>/<type>/<slug>).",
      );
    }

    // 1) Archive la saison qui se termine (écrase la N-1 précédente).
    for (const a of await ctx.db.query("abo_abonnes_archive").collect()) {
      await ctx.db.delete(a._id);
    }
    const scrap = await ctx.db.query("abo_abonnes_scrap").collect();
    for (const s of scrap) {
      await ctx.db.insert("abo_abonnes_archive", {
        licence: s.licence,
        nom: s.nom,
        prenom: s.prenom,
        nom_prenom_normalise: s.nom_prenom_normalise,
        abonnement_valide: s.abonnement_valide,
        saison,
      });
    }
    const nbArchive = scrap.length;

    // 2) Vide l'année en cours (scrap + élèves + créneaux/réservations + email_log).
    for (const s of scrap) await ctx.db.delete(s._id);
    for (const e of await ctx.db.query("abo_eleves_en_cours").collect()) {
      await ctx.db.delete(e._id);
    }
    for (const r of await ctx.db.query("abo_test_reservations").collect()) {
      await ctx.db.delete(r._id);
    }
    for (const c of await ctx.db.query("abo_test_creneaux").collect()) {
      await ctx.db.delete(c._id);
    }
    for (const l of await ctx.db.query("abo_email_log").collect()) {
      await ctx.db.delete(l._id);
    }
    // Les anciennes adresses ne sont tombstonées que pendant la campagne : au
    // reset, elles doivent pouvoir déposer une nouvelle demande normalement.
    // IO-BOUNDED: une campagne est limitée à 1 000 redirections ; au-delà, le
    // reset échoue atomiquement et exige un nettoyage supervisé par lots.
    const redirections = await ctx.db
      .query("abo_fusion_redirections_email")
      .take(MAX_REDIRECTIONS_PAR_CAMPAGNE + 1);
    if (redirections.length > MAX_REDIRECTIONS_PAR_CAMPAGNE) {
      throw new ConvexError({
        code: "ABO_RESET_TROP_DE_REDIRECTIONS",
        message: "Plus de 1 000 redirections de dossiers sont à nettoyer. Contactez un administrateur technique.",
      });
    }
    for (const redirection of redirections) {
      await ctx.db.delete(redirection._id);
    }

    // 3) Vide le cache et le suivi de TOUS les formulaires Abonnements connus
    //    (courant et anciens). Les commandes des cours ne sont jamais touchées.
    const cible = await trouverLienAbo(ctx);
    const liensAbo = (await ctx.db.query("helloasso_links").collect()).filter(
      (l) => l.type === "abonnement",
    );
    if (cible?.link && !liensAbo.some((l) => l._id === cible.link!._id)) {
      liensAbo.push(cible.link);
    }
    for (const lienAbo of liensAbo) {
      const dossiers = await ctx.db
        .query("dossiers")
        .withIndex("by_link", (q) => q.eq("helloasso_link_id", lienAbo._id))
        .collect();
      for (const d of dossiers) {
        const suivi = await ctx.db
          .query("abo_paiements_suivi")
          .withIndex("by_dossier_id", (q) => q.eq("dossier_id", d._id))
          .first();
        if (suivi) await ctx.db.delete(suivi._id);
        const txs = await ctx.db
          .query("helloasso_transactions")
          .withIndex("by_dossier", (q) => q.eq("dossier_id", d.dossier_id))
          .collect();
        for (const t of txs) await ctx.db.delete(t._id);
        await ctx.db.delete(d._id);
      }
    }

    // 4) Nouveau lien HelloAsso + réinitialisation des dates de vagues.
    await poserLienAbo(ctx, lien);
    await setConfigValeur(ctx, "vague1_debut", null);
    await setConfigValeur(ctx, "vague2_debut", null);
    await setConfigValeur(ctx, "vague3_debut", null);

    // 5) Purge des comptes publics (+ cascade) en tâche de fond, par lots bornés.
    await ctx.scheduler.runAfter(0, internal.abo.config.purgerComptesPublics, {});
    await ctx.scheduler.runAfter(0, internal.abo.compteur.rafraichirCompteurPublic, {});

    return nbArchive;
  },
});

// purgerComptesPublics() : supprime par lots les données et profils publics
// (dossiers → personnes / messages / email_log / réservations, suppressions).
// Un compte pouvant être à la fois demandeur et staff, la présence d'un
// userSettings conserve alors son user, ses sessions et ses comptes auth.
// Les comptes publics purs sont eux supprimés entièrement. Reprogrammé tant
// qu'il reste des profils à purger. Réservé aux appels internes (resetSaison). 🔒
const LOT_PURGE = 25;
export const purgerComptesPublics = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("abo_profiles").paginate({
      numItems: LOT_PURGE,
      cursor: args.cursor ?? null,
    });
    const profils = page.page;
    let traites = 0;
    for (const prof of profils) {
      if (prof.role === "admin") continue; // filet : ne jamais supprimer un admin
      const userId = prof.userId;
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first();

      const dossiers = await ctx.db
        .query("abo_dossiers")
        .withIndex("by_owner", (q) => q.eq("owner_id", userId))
        .collect();
      for (const d of dossiers) {
        const personnes = await ctx.db
          .query("abo_personnes")
          .withIndex("by_dossier", (q) => q.eq("dossier_id", d._id))
          .collect();
        for (const p of personnes) {
          const resas = await ctx.db
            .query("abo_test_reservations")
            .withIndex("by_personne", (q) => q.eq("personne_id", p._id))
            .collect();
          for (const r of resas) await ctx.db.delete(r._id);
          await ctx.db.delete(p._id);
        }
        const messages = await ctx.db
          .query("abo_messages")
          .withIndex("by_dossier", (q) => q.eq("dossier_id", d._id))
          .collect();
        for (const m of messages) await ctx.db.delete(m._id);
        const logs = await ctx.db
          .query("abo_email_log")
          .withIndex("by_dossier", (q) => q.eq("dossier_id", d._id))
          .collect();
        for (const el of logs) await ctx.db.delete(el._id);
        await ctx.db.delete(d._id);
      }

      const suppressions = await ctx.db
        .query("abo_demandes_supprimees")
        .withIndex("by_owner", (q) => q.eq("owner_id", userId))
        .collect();
      for (const sup of suppressions) await ctx.db.delete(sup._id);

      await ctx.db.delete(prof._id);
      traites++;

      // Un staff peut aussi déposer une demande avec le même compte. Le reset
      // purgera sa campagne publique, sans déconnecter ni effacer son accès staff.
      if (settings) continue;

      // Compte public pur : sessions (+ refresh tokens) → comptes → user.
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .collect();
      for (const sess of sessions) {
        const tokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", sess._id))
          .collect();
        for (const t of tokens) await ctx.db.delete(t._id);
        await ctx.db.delete(sess._id);
      }
      const comptes = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
        .collect();
      for (const acc of comptes) await ctx.db.delete(acc._id);

      await ctx.db.delete(userId);
    }

    // La progression dépend du curseur, jamais du nombre de suppressions : une
    // page composée uniquement de profils admin doit tout de même avancer.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.abo.config.purgerComptesPublics, {
        cursor: page.continueCursor,
      });
    }
    if (traites > 0) {
      await ctx.scheduler.runAfter(0, internal.abo.compteur.rafraichirCompteurPublic, {});
    }
    return traites;
  },
});
