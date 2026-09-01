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
import { internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { peutGererConfigurationAbo, requireAboConfigurationManager } from "./auth";
import { parseHa, poserLienAbo, trouverLienAbo } from "./paiements";
import { REGLEMENT_DOCUSEAL_URL } from "./reglementsConstants";
import { champsModifies } from "../dbUtils";
import { RESET_CAMPAIGN_SYNC_KEYS } from "./syncConstants";

const LOT_PURGE_SUIVI_CAMPAGNE = 25;
// SAISON-EXEMPT: état opérationnel de la campagne Abonnements, distinct de la
// saison comptable. Sans cette clé (compatibilité des campagnes existantes),
// les synchronisations restent actives.
export const CLE_SYNCHRONISATION_EXTERNE_ACTIVE = "synchronisation_externe_active";
const CLE_PURGE_SUIVI_CAMPAGNE_ACTIVE = "purge_suivi_campagne_active";
const CLE_SYNCHRONISATION_EXTERNE_GENERATION = "synchronisation_externe_generation";

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

export async function synchronisationExterneActive(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  return (await getConfigValeur(ctx, CLE_SYNCHRONISATION_EXTERNE_ACTIVE)) !== "false";
}

// Lecture exclusivement serveur : les actions l'utilisent avant tout appel
// externe afin que le bouton UI ne soit jamais la seule protection.
export const synchronisationExterneActiveInterne = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => synchronisationExterneActive(ctx),
});

export const etatSynchronisationExterneInterne = internalQuery({
  args: {},
  returns: v.object({ active: v.boolean(), generation: v.number() }),
  handler: async (ctx) => ({
    active: await synchronisationExterneActive(ctx),
    generation: Number(await getConfigValeur(ctx, CLE_SYNCHRONISATION_EXTERNE_GENERATION)) || 0,
  }),
});

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
    if (champsModifies(row, patch, ["updated_at"])) {
      await ctx.db.patch(row._id, patch);
    }
  } else {
    await ctx.db.insert("abo_app_config", { cle, ...patch });
  }
}

async function supprimerConfigValeurs(
  ctx: MutationCtx,
  cles: readonly string[],
): Promise<void> {
  for (const cle of cles) {
    const row = await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", cle))
      .unique();
    if (row) await ctx.db.delete(row._id);
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
    synchronisation_externe_active: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAboConfigurationManager(ctx);
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
      synchronisation_externe_active: await synchronisationExterneActive(ctx),
    };
  },
});

// Droit d'affichage de l'onglet Configuration. Il ne divulgue aucune valeur de
// configuration et évite d'appeler getConfig pour un membre non autorisé.
export const peutGererConfiguration = authenticatedQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => peutGererConfigurationAbo(ctx),
});

export const setSynchronisationExterneActive = authenticatedMutation({
  args: { active: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireAboConfigurationManager(ctx);
    if (
      args.active &&
      (await getConfigValeur(ctx, CLE_PURGE_SUIVI_CAMPAGNE_ACTIVE)) === "true"
    ) {
      throw new ConvexError({
        code: "ABO_PURGE_CAMPAGNE_EN_COURS",
        message: "La purge des suivis de la campagne précédente est encore en cours.",
      });
    }
    await setConfigValeur(
      ctx,
      CLE_SYNCHRONISATION_EXTERNE_ACTIVE,
      args.active ? "true" : "false",
    );
    return args.active;
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
    await requireAboConfigurationManager(ctx);
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
    await requireAboConfigurationManager(ctx);
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
// réinitialise les dates de vagues, PUIS programme la purge par lots des comptes
// publics et de tous les suivis de campagne. Les fichiers historiques restent
// dans Drive, sans conserver leur état opérationnel dans Convex.
// Les comptes staff/admin sont CONSERVÉS. 🔒
export const resetSaison = authenticatedMutation({
  args: { saisonArchivee: v.string(), nouveauLien: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireAboConfigurationManager(ctx);
    const saison = args.saisonArchivee.trim();
    const lien = args.nouveauLien.trim();
    if (!saison) {
      throw new ConvexError({
        code: "ABO_SAISON_ARCHIVEE_REQUISE",
        message: "Libellé de la saison à archiver requis.",
      });
    }
    if (!lien) {
      throw new ConvexError({
        code: "ABO_LIEN_HELLOASSO_REQUIS",
        message: "Nouveau lien HelloAsso requis.",
      });
    }
    if (!parseHa(lien)) {
      throw new ConvexError({
        code: "ABO_LIEN_HELLOASSO_INVALIDE",
        message: "Lien HelloAsso non reconnu (attendu : .../associations/<org>/<type>/<slug>).",
      });
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
    // IO-BOUNDED: le suivi opérationnel ne peut pas dépasser les 1 000
    // personnes du snapshot élèves et doit disparaître avec celui-ci.
    const traitementsLicencesCours = await ctx.db
      .query("abo_licences_cours_traitements")
      .take(1_001);
    if (traitementsLicencesCours.length > 1_000) {
      throw new ConvexError({
        code: "54000",
        message: "Le suivi des licences en cours dépasse la limite de 1 000 personnes.",
      });
    }
    for (const traitement of traitementsLicencesCours) {
      await ctx.db.delete(traitement._id);
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
    // Les snapshots de campagne viennent d'être vidés : leurs réussites et
    // verrous manuels ne doivent pas retarder la première synchro de la saison.
    // L'annuaire des licences, transversal, est volontairement conservé.
    await supprimerConfigValeurs(ctx, RESET_CAMPAIGN_SYNC_KEYS);
    // Le site club et l'annuaire peuvent encore porter la campagne N-1 : leur
    // synchronisation reste explicitement en pause jusqu'au feu vert staff.
    await setConfigValeur(ctx, CLE_SYNCHRONISATION_EXTERNE_ACTIVE, "false");
    await setConfigValeur(ctx, CLE_PURGE_SUIVI_CAMPAGNE_ACTIVE, "true");
    const generation = Number(await getConfigValeur(ctx, CLE_SYNCHRONISATION_EXTERNE_GENERATION)) || 0;
    await setConfigValeur(ctx, CLE_SYNCHRONISATION_EXTERNE_GENERATION, String(generation + 1));

    // 5) Purges en tâche de fond, par lots bornés. Les dépendances sont
    // supprimées avant leurs parents (uploads → archives, notifications →
    // fusions) afin de ne laisser aucun état de suivi à la campagne suivante.
    await ctx.scheduler.runAfter(0, internal.abo.config.purgerSuiviCampagne, {
      etape: "acquittements_anomalies",
    });
    await ctx.scheduler.runAfter(0, internal.abo.config.purgerComptesPublics, {});
    await ctx.scheduler.runAfter(0, internal.abo.compteur.rafraichirCompteurPublic, {});

    return nbArchive;
  },
});

const etapePurgeSuiviValidator = v.union(
  v.literal("acquittements_anomalies"),
  v.literal("journal_anomalies"),
  v.literal("uploads_tests"),
  v.literal("archives_tests"),
  v.literal("imports_reglements"),
  v.literal("reglements_signes"),
  v.literal("notifications_fusions"),
  v.literal("redirections_fusions"),
  v.literal("fusions_dossiers"),
  v.literal("fusions_licences"),
);

type EtapePurgeSuivi =
  | "acquittements_anomalies"
  | "journal_anomalies"
  | "uploads_tests"
  | "archives_tests"
  | "imports_reglements"
  | "reglements_signes"
  | "notifications_fusions"
  | "redirections_fusions"
  | "fusions_dossiers"
  | "fusions_licences";

const ETAPES_PURGE_SUIVI: readonly EtapePurgeSuivi[] = [
  "acquittements_anomalies",
  "journal_anomalies",
  "uploads_tests",
  "archives_tests",
  "imports_reglements",
  "reglements_signes",
  "notifications_fusions",
  "redirections_fusions",
  "fusions_dossiers",
  "fusions_licences",
];

function etapeSuivante(etape: EtapePurgeSuivi): EtapePurgeSuivi | null {
  const index = ETAPES_PURGE_SUIVI.indexOf(etape);
  return ETAPES_PURGE_SUIVI[index + 1] ?? null;
}

// Purge les tables de suivi de la campagne, une table et 25 documents à la
// fois. Les fichiers Drive ne sont jamais touchés. Les blobs Convex ne vivent
// que dans les tickets/imports : ils doivent en revanche être libérés avant de
// supprimer leur ligne. IO-BOUNDED: au plus 25 documents lus/supprimés par run.
export const purgerSuiviCampagne = internalMutation({
  args: { etape: etapePurgeSuiviValidator },
  returns: v.number(),
  handler: async (ctx, args) => {
    let traites = 0;
    switch (args.etape) {
      case "acquittements_anomalies": {
        const acquittements = await ctx.db
          .query("abo_anomalies_acquittements")
          .take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const acquittement of acquittements) await ctx.db.delete(acquittement._id);
        traites = acquittements.length;
        break;
      }
      case "journal_anomalies": {
        const journal = await ctx.db
          .query("abo_anomalies_acquittements_journal")
          .take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const entree of journal) await ctx.db.delete(entree._id);
        traites = journal.length;
        break;
      }
      case "uploads_tests": {
        const uploads = await ctx.db.query("abo_test_document_uploads").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const upload of uploads) {
          if (upload.storage_id) await ctx.storage.delete(upload.storage_id);
          await ctx.db.delete(upload._id);
        }
        traites = uploads.length;
        break;
      }
      case "archives_tests": {
        const archives = await ctx.db.query("abo_tests_autonomie_archive").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const archive of archives) await ctx.db.delete(archive._id);
        traites = archives.length;
        break;
      }
      case "imports_reglements": {
        const imports = await ctx.db.query("abo_reglements_imports").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const importReglement of imports) {
          if (importReglement.storage_id) await ctx.storage.delete(importReglement.storage_id);
          await ctx.db.delete(importReglement._id);
        }
        traites = imports.length;
        break;
      }
      case "reglements_signes": {
        const reglements = await ctx.db.query("abo_reglements_signes").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const reglement of reglements) await ctx.db.delete(reglement._id);
        traites = reglements.length;
        break;
      }
      case "notifications_fusions": {
        const notifications = await ctx.db.query("abo_fusion_notifications").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const notification of notifications) await ctx.db.delete(notification._id);
        traites = notifications.length;
        break;
      }
      case "redirections_fusions": {
        const redirections = await ctx.db.query("abo_fusion_redirections_email").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const redirection of redirections) await ctx.db.delete(redirection._id);
        traites = redirections.length;
        break;
      }
      case "fusions_dossiers": {
        const fusions = await ctx.db.query("abo_fusions_dossiers").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const fusion of fusions) await ctx.db.delete(fusion._id);
        traites = fusions.length;
        break;
      }
      case "fusions_licences": {
        const fusions = await ctx.db.query("abo_licence_fusions").take(LOT_PURGE_SUIVI_CAMPAGNE);
        for (const fusion of fusions) await ctx.db.delete(fusion._id);
        traites = fusions.length;
        break;
      }
    }

    const prochaineEtape = traites === LOT_PURGE_SUIVI_CAMPAGNE
      ? args.etape
      : etapeSuivante(args.etape);
    if (prochaineEtape) {
      await ctx.scheduler.runAfter(0, internal.abo.config.purgerSuiviCampagne, {
        etape: prochaineEtape,
      });
    } else {
      await setConfigValeur(ctx, CLE_PURGE_SUIVI_CAMPAGNE_ACTIVE, null);
    }
    return traites;
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
