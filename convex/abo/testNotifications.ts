import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { requireAboIdentity } from "./auth";
import { estReservationBloquante } from "./lib";

const DELAI_REGROUPEMENT_MS = 30 * 60 * 1_000;
const TAILLE_LOT_EMAIL = 25;
const URL_RESERVATION = "https://esca-caf-la-roche.github.io/portail/#/abonnements";

type Ctx = QueryCtx | MutationCtx;
type StatutAttente = Doc<"abo_test_attentes_notifications">["statut"];
const STATUTS_AUTONOMIE_A_NOTIFIER = [
  "Recherche du test en cours",
  "Doit passer le test",
] as const;

function emailCanonique(email: string): string {
  return email.trim().toLocaleLowerCase("fr-FR");
}

function emailValide(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function licenceValide(licence: string): boolean {
  return /^(?:\d{12}|\d{14})$/.test(licence.trim());
}

async function scrapEligibleNotificationForcee(
  ctx: Ctx,
  scrap: Doc<"abo_abonnes_scrap">,
  cleEmail?: string,
): Promise<boolean> {
  const email = scrap.email ? emailCanonique(scrap.email) : "";
  const licence = scrap.licence?.trim();
  if (
    !STATUTS_AUTONOMIE_A_NOTIFIER.includes(scrap.autonomie as typeof STATUTS_AUTONOMIE_A_NOTIFIER[number]) ||
    scrap.age === undefined ||
    scrap.age < 16 ||
    !scrap.nom?.trim() ||
    !scrap.prenom?.trim() ||
    !emailValide(email) ||
    (cleEmail !== undefined && email !== cleEmail) ||
    !licence ||
    !licenceValide(licence)
  ) return false;
  const eleve = await ctx.db
    .query("abo_eleves_en_cours")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .first();
  return !eleve && !(await reservationActivePourLicence(ctx, licence));
}

function cleDirecte(id: Id<"abo_test_candidats_directs">): string {
  return `direct:${id}`;
}

function cleDossier(id: Id<"abo_personnes">): string {
  return `dossier:${id}`;
}

async function reservationActivePourLicence(ctx: Ctx, licence: string): Promise<boolean> {
  const directes = await ctx.db
    .query("abo_test_reservations")
    .withIndex("by_candidat_licence", (q) => q.eq("candidat_licence", licence))
    .collect();
  if (directes.some((r) => estReservationBloquante(r, Date.now()))) return true;

  const personnes = await ctx.db
    .query("abo_personnes")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .take(20);
  for (const personne of personnes) {
    const reservations = await ctx.db
      .query("abo_test_reservations")
      .withIndex("by_personne", (q) => q.eq("personne_id", personne._id))
      .collect();
    if (reservations.some((r) => estReservationBloquante(r, Date.now()))) return true;
  }
  return false;
}

// Réservation bloquante d'une personne (parcours dossier), même règle
// temporelle que reservationActivePourLicence : une réservation passée sans
// résultat n'est plus annulable, donc ne doit plus bloquer ni supprimer les
// alertes.
async function reservationBloquantePourPersonne(ctx: Ctx, personneId: Id<"abo_personnes">): Promise<boolean> {
  const reservations = await ctx.db
    .query("abo_test_reservations")
    .withIndex("by_personne", (q) => q.eq("personne_id", personneId))
    .collect();
  const maintenant = Date.now();
  return reservations.some((r) => estReservationBloquante(r, maintenant));
}

async function candidatDirectEligible(
  ctx: Ctx,
  candidat: Doc<"abo_test_candidats_directs">,
): Promise<boolean> {
  const [scrap, eleve] = await Promise.all([
    ctx.db
      .query("abo_abonnes_scrap")
      .withIndex("by_licence", (q) => q.eq("licence", candidat.licence))
      .first(),
    ctx.db
      .query("abo_eleves_en_cours")
      .withIndex("by_licence", (q) => q.eq("licence", candidat.licence))
      .first(),
  ]);
  return Boolean(
    scrap &&
      !eleve &&
      scrap.autonomie !== "OK" &&
      Boolean(scrap.autonomie) &&
      scrap.age !== undefined &&
      scrap.age >= 16 &&
      scrap.nom &&
      scrap.prenom,
  );
}

async function personneDossierEligible(
  ctx: Ctx,
  personne: Doc<"abo_personnes">,
  userId: Id<"users">,
): Promise<boolean> {
  const dossier = await ctx.db.get(personne.dossier_id);
  if (!dossier || dossier.owner_id !== userId) return false;
  if (
    personne.etape_validation !== "validee" ||
    personne.etape_test_autonomie !== "requis" ||
    (personne.age !== undefined && personne.age < 16)
  ) {
    return false;
  }
  if (personne.licence) {
    const eleve = await ctx.db
      .query("abo_eleves_en_cours")
      .withIndex("by_licence", (q) => q.eq("licence", personne.licence!))
      .first();
    if (eleve) return false;
  }
  return true;
}

async function attenteParCle(ctx: Ctx, cle: string) {
  return await ctx.db
    .query("abo_test_attentes_notifications")
    .withIndex("by_cle_candidat", (q) => q.eq("cle_candidat", cle))
    .first();
}

export async function marquerAttente(
  ctx: MutationCtx,
  cle: string,
  statut: StatutAttente,
): Promise<void> {
  const attente = await attenteParCle(ctx, cle);
  if (statut === "en_attente" && attente?.statut !== "reservee") return;
  if (statut === "reservee" && attente?.statut === "desabonnee") return;
  if (attente && attente.statut !== statut) {
    await ctx.db.patch(attente._id, {
      statut,
      modifie_le: Date.now(),
    });
  }
}

export async function ouvrirLotNotification(
  ctx: MutationCtx,
): Promise<Id<"abo_test_notification_lots"> | undefined> {
  const existant = await ctx.db
    .query("abo_test_notification_lots")
    .withIndex("by_statut", (q) => q.eq("statut", "en_attente"))
    .first();
  if (existant) return existant._id;

  const maintenant = Date.now();
  const lotId = await ctx.db.insert("abo_test_notification_lots", {
    mode: "nouveaux_creneaux",
    statut: "en_attente",
    ouvert_le: maintenant,
    envoi_prevu_le: maintenant + DELAI_REGROUPEMENT_MS,
    phase_preparation: "attentes",
  });
  await ctx.scheduler.runAfter(
    DELAI_REGROUPEMENT_MS,
    internal.abo.testNotifications.envoyerLot,
    { lotId },
  );
  return lotId;
}

async function creerLotRattrapage(
  ctx: MutationCtx,
  cleIdempotence: string,
): Promise<Id<"abo_test_notification_lots">> {
  const cle = cleIdempotence.trim();
  if (!cle || cle.length > 120) {
    throw new ConvexError({ code: "ABO_TEST_CLE_RATTRAPAGE_INVALIDE", message: "Clé de rattrapage requise (120 caractères maximum)." });
  }
  const existant = await ctx.db
    .query("abo_test_notification_lots")
    .withIndex("by_cle_idempotence", (q) => q.eq("cle_idempotence", cle))
    .unique();
  if (existant) return existant._id;
  const maintenant = Date.now();
  const lotId = await ctx.db.insert("abo_test_notification_lots", {
    mode: "rattrapage",
    cle_idempotence: cle,
    statut: "en_attente",
    ouvert_le: maintenant,
    envoi_prevu_le: maintenant,
    phase_preparation: "attentes",
  });
  await ctx.scheduler.runAfter(0, internal.abo.testNotifications.envoyerLot, { lotId });
  return lotId;
}

// Endpoint exclusivement serveur pour une exécution de maintenance via le CLI
// Convex. La clé explicite rend tout rejeu idempotent.
export const declencherRattrapageInterne = internalMutation({
  args: { cleIdempotence: v.string() },
  returns: v.id("abo_test_notification_lots"),
  handler: async (ctx, args) => await creerLotRattrapage(ctx, args.cleIdempotence),
});

export const mesSuivisDisponibilites = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const id = await requireAboIdentity(ctx);
    const attentes = await ctx.db
      .query("abo_test_attentes_notifications")
      .withIndex("by_user_id", (q) => q.eq("user_id", id.userId))
      .take(100);
    return attentes.map((attente) => ({
      cle: attente.cle_candidat,
      statut: attente.statut,
    }));
  },
});

export const suivreCandidatDirect = authenticatedMutation({
  args: { candidatId: v.id("abo_test_candidats_directs"), actif: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = await requireAboIdentity(ctx);
    const candidat = await ctx.db.get(args.candidatId);
    if (!candidat || candidat.user_id !== id.userId) {
      throw new ConvexError({ code: "P0002", message: "Candidat introuvable." });
    }
    const cle = cleDirecte(candidat._id);
    const existante = await attenteParCle(ctx, cle);
    const maintenant = Date.now();
    if (!args.actif) {
      if (existante) await ctx.db.patch(existante._id, { statut: "desabonnee", modifie_le: maintenant });
      return null;
    }
    if (!(await candidatDirectEligible(ctx, candidat)) || await reservationActivePourLicence(ctx, candidat.licence)) {
      throw new ConvexError({ code: "TEST_DIRECT_NON_ELIGIBLE", message: "Cette personne ne peut pas être inscrite aux alertes de créneaux." });
    }
    const memesLicences = await ctx.db
      .query("abo_test_candidats_directs")
      .withIndex("by_licence", (q) => q.eq("licence", candidat.licence))
      .take(10);
    for (const autre of memesLicences) {
      if (autre.user_id === id.userId) continue;
      const autreAttente = await attenteParCle(ctx, cleDirecte(autre._id));
      if (autreAttente?.statut === "en_attente") {
        throw new ConvexError({
          code: "ABO_TEST_ALERTE_DEJA_RATTACHEE",
          message: "Une alerte existe déjà pour cette licence sur un autre compte. Contactez la commission abonnements pour changer de responsable.",
        });
      }
    }
    if (existante) {
      if (existante.statut !== "en_attente") await ctx.db.patch(existante._id, { statut: "en_attente", modifie_le: maintenant });
    } else {
      await ctx.db.insert("abo_test_attentes_notifications", {
        user_id: id.userId,
        type_candidat: "direct",
        candidat_direct_id: candidat._id,
        cle_candidat: cle,
        statut: "en_attente",
        cree_le: maintenant,
        modifie_le: maintenant,
      });
    }
    return null;
  },
});

export const suivrePersonneDossier = authenticatedMutation({
  args: { personneId: v.id("abo_personnes"), actif: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = await requireAboIdentity(ctx);
    const personne = await ctx.db.get(args.personneId);
    const dossier = personne ? await ctx.db.get(personne.dossier_id) : null;
    if (!personne || !dossier || dossier.owner_id !== id.userId) {
      throw new ConvexError({ code: "P0002", message: "Personne introuvable." });
    }
    const cle = cleDossier(personne._id);
    const existante = await attenteParCle(ctx, cle);
    const maintenant = Date.now();
    if (!args.actif) {
      if (existante) await ctx.db.patch(existante._id, { statut: "desabonnee", modifie_le: maintenant });
      return null;
    }
    if (!(await personneDossierEligible(ctx, personne, id.userId))) {
      throw new ConvexError({ code: "TEST_DOSSIER_NON_ELIGIBLE", message: "Cette personne ne peut pas être inscrite aux alertes de créneaux." });
    }
    if (
      (personne.licence && await reservationActivePourLicence(ctx, personne.licence)) ||
      (!personne.licence && await reservationBloquantePourPersonne(ctx, personne._id))
    ) {
      throw new ConvexError({ code: "P0011", message: "Cette personne a déjà une réservation." });
    }
    if (existante) {
      if (existante.statut !== "en_attente") await ctx.db.patch(existante._id, { statut: "en_attente", modifie_le: maintenant });
    } else {
      await ctx.db.insert("abo_test_attentes_notifications", {
        user_id: id.userId,
        type_candidat: "dossier",
        personne_id: personne._id,
        cle_candidat: cle,
        statut: "en_attente",
        cree_le: maintenant,
        modifie_le: maintenant,
      });
    }
    return null;
  },
});

type ContexteDestinataire = {
  destinataire: string;
  personnes: string[];
  licences: string[];
};

async function contexteDestinataire(
  ctx: Ctx,
  userId: string,
): Promise<ContexteDestinataire | null> {
  const userDocId = ctx.db.normalizeId("users", userId);
  if (!userDocId) return null;
  const user = await ctx.db.get(userDocId);
  const destinataire = typeof user?.email === "string" ? user.email.trim() : "";
  if (!destinataire) return null;
  const attentes = await ctx.db
    .query("abo_test_attentes_notifications")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .take(100);
  const personnes: string[] = [];
  for (const attente of attentes.filter((ligne) => ligne.statut === "en_attente")) {
    if (attente.type_candidat === "direct" && attente.candidat_direct_id) {
      const candidat = await ctx.db.get(attente.candidat_direct_id);
      if (
        candidat &&
        candidat.user_id === userId &&
        await candidatDirectEligible(ctx, candidat) &&
        !(await reservationActivePourLicence(ctx, candidat.licence))
      ) {
        personnes.push(`${candidat.prenom} ${candidat.nom}`.trim());
      }
    } else if (attente.type_candidat === "dossier" && attente.personne_id) {
      const personne = await ctx.db.get(attente.personne_id);
      if (
        personne &&
        await personneDossierEligible(ctx, personne, userDocId) &&
        !(personne.licence && await reservationActivePourLicence(ctx, personne.licence))
      ) {
        if (!(await reservationBloquantePourPersonne(ctx, personne._id))) {
          personnes.push(`${personne.prenom} ${personne.nom}`.trim());
        }
      }
    }
  }
  return personnes.length > 0 ? { destinataire, personnes: [...new Set(personnes)], licences: [] } : null;
}

async function contexteScrap(
  ctx: Ctx,
  destinataire: string,
  licences: string[],
): Promise<ContexteDestinataire | null> {
  const cle = emailCanonique(destinataire);
  const personnes: string[] = [];
  const licencesEligibles: string[] = [];
  for (const licence of licences) {
    const scrap = await ctx.db
      .query("abo_abonnes_scrap")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .first();
    if (!scrap || !(await scrapEligibleNotificationForcee(ctx, scrap, cle))) continue;
    const prenom = scrap.prenom?.trim();
    const nom = scrap.nom?.trim();
    const licenceEligible = scrap.licence?.trim();
    if (!prenom || !nom || !licenceEligible) continue;
    personnes.push(`${prenom} ${nom}`);
    licencesEligibles.push(licenceEligible);
  }
  return personnes.length > 0
    ? { destinataire: cle, personnes: [...new Set(personnes)], licences: [...new Set(licencesEligibles)] }
    : null;
}

async function ajouterOuFusionnerEnvoi(
  ctx: MutationCtx,
  lotId: Id<"abo_test_notification_lots">,
  destinataire: string,
  personnes: string[],
  licences: string[],
  userId?: string,
): Promise<boolean> {
  const cle = emailCanonique(destinataire);
  if (!emailValide(cle)) return false;
  const existant = await ctx.db
    .query("abo_test_notification_envois")
    .withIndex("by_lot_id_and_cle_destinataire", (q) => q.eq("lot_id", lotId).eq("cle_destinataire", cle))
    .first();
  const existantHistorique = !existant && userId
    ? await ctx.db
        .query("abo_test_notification_envois")
        .withIndex("by_lot_id_and_user_id", (q) => q.eq("lot_id", lotId).eq("user_id", userId))
        .first()
    : null;
  const ligneExistante = existant ?? existantHistorique;
  if (ligneExistante) {
    const nouvellesPersonnes = [...new Set([...ligneExistante.personnes, ...personnes])];
    const nouvellesLicences = [...new Set([...(ligneExistante.licences ?? []), ...licences])];
    if (
      ligneExistante.cle_destinataire !== cle ||
      nouvellesPersonnes.length !== ligneExistante.personnes.length ||
      nouvellesLicences.length !== (ligneExistante.licences?.length ?? 0)
    ) {
      await ctx.db.patch(ligneExistante._id, {
        cle_destinataire: cle,
        destinataire: cle,
        personnes: nouvellesPersonnes,
        licences: nouvellesLicences,
      });
    }
    return false;
  }
  await ctx.db.insert("abo_test_notification_envois", {
    lot_id: lotId,
    user_id: userId,
    cle_destinataire: cle,
    destinataire: cle,
    personnes: [...new Set(personnes)],
    licences: [...new Set(licences)],
    statut: "a_envoyer",
    tentatives: 0,
    cree_le: Date.now(),
  });
  return true;
}

export const preparerLot = internalMutation({
  args: { lotId: v.id("abo_test_notification_lots") },
  returns: v.object({ terminee: v.boolean(), crees: v.number() }),
  handler: async (ctx, args) => {
    const lot = await ctx.db.get(args.lotId);
    if (!lot || (lot.statut !== "en_attente" && lot.statut !== "preparation")) return { terminee: true, crees: 0 };
    if (lot.preparation_terminee) return { terminee: true, crees: 0 };
    if (lot.statut === "en_attente") await ctx.db.patch(lot._id, { statut: "preparation" });

    let crees = 0;
    if ((lot.phase_preparation ?? "attentes") === "attentes") {
      const page = await ctx.db
        .query("abo_test_attentes_notifications")
        .withIndex("by_statut", (q) => q.eq("statut", "en_attente"))
        .paginate({ numItems: TAILLE_LOT_EMAIL, cursor: lot.curseur_attentes ?? null });
      const userIds = [...new Set(page.page.map((attente) => attente.user_id))];
      for (const userId of userIds) {
        const contexte = await contexteDestinataire(ctx, userId);
        if (contexte && await ajouterOuFusionnerEnvoi(ctx, lot._id, contexte.destinataire, contexte.personnes, [], userId)) crees += 1;
      }
      await ctx.db.patch(lot._id, page.isDone
        ? { curseur_attentes: undefined, phase_preparation: "scrap", curseur_scrap: undefined }
        : { curseur_attentes: page.continueCursor });
      return { terminee: false, crees };
    }

    const curseurBrut = lot.curseur_scrap;
    const secondStatut = curseurBrut?.startsWith("doit:") ?? false;
    const statut = secondStatut ? STATUTS_AUTONOMIE_A_NOTIFIER[1] : STATUTS_AUTONOMIE_A_NOTIFIER[0];
    const curseur = curseurBrut ? curseurBrut.slice(curseurBrut.indexOf(":") + 1) || null : null;
    const page = await ctx.db
      .query("abo_abonnes_scrap")
      .withIndex("by_autonomie", (q) => q.eq("autonomie", statut))
      .paginate({ numItems: TAILLE_LOT_EMAIL, cursor: curseur });
    for (const scrap of page.page) {
      const email = scrap.email ? emailCanonique(scrap.email) : "";
      if (!(await scrapEligibleNotificationForcee(ctx, scrap))) continue;
      const prenom = scrap.prenom?.trim();
      const nom = scrap.nom?.trim();
      const licence = scrap.licence?.trim();
      if (!prenom || !nom || !licence) continue;
      if (await ajouterOuFusionnerEnvoi(ctx, lot._id, email, [`${prenom} ${nom}`], [licence])) crees += 1;
    }
    if (!page.isDone) {
      await ctx.db.patch(lot._id, { curseur_scrap: `${secondStatut ? "doit" : "recherche"}:${page.continueCursor}` });
      return { terminee: false, crees };
    }
    if (!secondStatut) {
      await ctx.db.patch(lot._id, { curseur_scrap: "doit:" });
      return { terminee: false, crees };
    }
    await ctx.db.patch(lot._id, { curseur_scrap: undefined, preparation_terminee: true });
    return { terminee: true, crees };
  },
});

export const aDesEnvoisAEffectuer = internalQuery({
  args: { lotId: v.id("abo_test_notification_lots") },
  returns: v.boolean(),
  handler: async (ctx, args) => Boolean(await ctx.db
    .query("abo_test_notification_envois")
    .withIndex("by_lot_id_and_statut", (q) => q.eq("lot_id", args.lotId).eq("statut", "a_envoyer"))
    .first()),
});

export const modeLot = internalQuery({
  args: { lotId: v.id("abo_test_notification_lots") },
  returns: v.union(v.literal("nouveaux_creneaux"), v.literal("rattrapage")),
  handler: async (ctx, args) => {
    const lot = await ctx.db.get(args.lotId);
    return lot?.mode === "rattrapage" ? "rattrapage" : "nouveaux_creneaux";
  },
});

export const reclamerProchainEnvoi = internalMutation({
  args: { lotId: v.id("abo_test_notification_lots") },
  handler: async (ctx, args) => {
    const envoi = await ctx.db
      .query("abo_test_notification_envois")
      .withIndex("by_lot_id_and_statut", (q) => q.eq("lot_id", args.lotId).eq("statut", "a_envoyer"))
      .first();
    if (!envoi) return null;
    const volontaire = envoi.user_id ? await contexteDestinataire(ctx, envoi.user_id) : null;
    const force = await contexteScrap(ctx, envoi.destinataire, envoi.licences ?? []);
    const contexte = volontaire || force
      ? {
          destinataire: force?.destinataire ?? volontaire!.destinataire,
          personnes: [...new Set([...(volontaire?.personnes ?? []), ...(force?.personnes ?? [])])],
          licences: force?.licences ?? [],
        }
      : null;
    if (!contexte) {
      await ctx.db.patch(envoi._id, { statut: "echec", tentatives: envoi.tentatives + 1, erreur: "Le candidat n'est plus éligible." });
      return null;
    }
    await ctx.db.patch(envoi._id, {
      statut: "en_cours",
      tentatives: envoi.tentatives + 1,
      reclame_le: Date.now(),
      destinataire: contexte.destinataire,
      personnes: contexte.personnes,
      licences: contexte.licences,
    });
    return { envoiId: envoi._id, ...contexte };
  },
});

export const recupererClaimsExpires = internalMutation({
  args: { lotId: v.id("abo_test_notification_lots") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const expiresAvant = Date.now() - 15 * 60 * 1_000;
    const claims = await ctx.db
      .query("abo_test_notification_envois")
      .withIndex("by_lot_id_and_statut", (q) => q.eq("lot_id", args.lotId).eq("statut", "en_cours"))
      .take(TAILLE_LOT_EMAIL);
    let recuperes = 0;
    for (const claim of claims) {
      if ((claim.reclame_le ?? claim.cree_le) > expiresAvant) continue;
      await ctx.db.patch(claim._id, claim.tentatives < 2
        ? { statut: "a_envoyer", reclame_le: undefined, erreur: "Reprise après interruption de l'envoi." }
        : { statut: "echec", reclame_le: undefined, erreur: "Envoi abandonné après deux tentatives." });
      recuperes += 1;
    }
    return recuperes;
  },
});

export const terminerEnvoi = internalMutation({
  args: {
    envoiId: v.id("abo_test_notification_envois"),
    succes: v.boolean(),
    erreur: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const envoi = await ctx.db.get(args.envoiId);
    if (!envoi || envoi.statut !== "en_cours") return null;
    await ctx.db.patch(envoi._id, {
      statut: args.succes ? "envoye" : "echec",
      envoye_le: args.succes ? Date.now() : undefined,
      reclame_le: undefined,
      erreur: args.erreur?.slice(0, 500),
    });
    return null;
  },
});

export const finaliserLot = internalMutation({
  args: { lotId: v.id("abo_test_notification_lots"), sansDestinataire: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lot = await ctx.db.get(args.lotId);
    if (!lot || lot.statut === "termine" || lot.statut === "sans_destinataire") return null;
    await ctx.db.patch(lot._id, {
      statut: args.sansDestinataire ? "sans_destinataire" : "termine",
      termine_le: Date.now(),
    });
    return null;
  },
});

function formaterCreneau(debut: string, fin: string): string {
  const jour = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(debut));
  const heure = (iso: string) => new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${jour}, de ${heure(debut)} à ${heure(fin)}`;
}

export const envoyerLot = internalAction({
  args: { lotId: v.id("abo_test_notification_lots") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.abo.testNotifications.recupererClaimsExpires, { lotId: args.lotId });
    const mode = await ctx.runQuery(internal.abo.testNotifications.modeLot, { lotId: args.lotId });
    const creneaux = await ctx.runQuery(internal.abo.tests.disponibilitesPourNotification, { lotId: args.lotId });
    if (creneaux.length === 0) {
      await ctx.runMutation(internal.abo.testNotifications.finaliserLot, { lotId: args.lotId, sansDestinataire: true });
      return null;
    }
    const preparation = await ctx.runMutation(internal.abo.testNotifications.preparerLot, { lotId: args.lotId });
    if (!preparation.terminee) {
      await ctx.scheduler.runAfter(0, internal.abo.testNotifications.envoyerLot, { lotId: args.lotId });
      return null;
    }
    let traites = 0;
    while (traites < TAILLE_LOT_EMAIL) {
      const contexte = await ctx.runMutation(internal.abo.testNotifications.reclamerProchainEnvoi, { lotId: args.lotId });
      if (!contexte) break;
      traites += 1;
      const texte = [
        "Bonjour,",
        "",
        mode === "rattrapage"
          ? `Des créneaux sont actuellement disponibles pour le test d'autonomie de ${contexte.personnes.join(", ")}.`
          : `Des disponibilités ont été ajoutées pour le test d'autonomie de ${contexte.personnes.join(", ")}.`,
        "Voici tous les créneaux actuellement réservables :",
        "",
        ...creneaux.map((creneau) => `- ${formaterCreneau(creneau.tranche_debut, creneau.tranche_fin)} (${creneau.disponible} place${creneau.disponible > 1 ? "s" : ""})`),
        "",
        `Réserver : ${URL_RESERVATION}`,
        "",
        "Ce message vous est envoyé automatiquement car le test d'autonomie reste à passer et aucune réservation en cours n'est enregistrée.",
        "",
        "Commission abonnements — ESCA",
      ].join("\n");
      try {
        await ctx.runAction(internal.email.sendAboEmail, {
          to: contexte.destinataire,
          subject: mode === "rattrapage"
            ? "Créneaux actuellement disponibles pour le test d'autonomie"
            : "Nouveaux créneaux de test d'autonomie",
          text: texte,
        });
        await ctx.runMutation(internal.abo.testNotifications.terminerEnvoi, { envoiId: contexte.envoiId, succes: true });
      } catch (error) {
        await ctx.runMutation(internal.abo.testNotifications.terminerEnvoi, {
          envoiId: contexte.envoiId,
          succes: false,
          erreur: error instanceof Error ? error.message : "Échec d'envoi SMTP",
        });
      }
    }
    const reste = await ctx.runQuery(internal.abo.testNotifications.aDesEnvoisAEffectuer, { lotId: args.lotId });
    if (reste) {
      await ctx.scheduler.runAfter(0, internal.abo.testNotifications.envoyerLot, { lotId: args.lotId });
    } else {
      await ctx.runMutation(internal.abo.testNotifications.finaliserLot, { lotId: args.lotId, sansDestinataire: traites === 0 });
    }
    return null;
  },
});
