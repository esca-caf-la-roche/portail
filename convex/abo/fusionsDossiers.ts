import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { canoniserEmailUnique } from "../emailValidation";
import { champsModifies } from "../dbUtils";
import { requireAboAdmin } from "./auth";
import { champsPersonneDepuisScrap } from "./matching";
import { programmerRafraichissementCompteurPublic } from "./compteur";

const MAX_PERSONNES = 30;
const MAX_MESSAGES = 100;
const MAX_LOGS = 100;
const MAX_RESERVATIONS = 30;
const MAX_HISTORIQUES = 100;
const MAX_REDIRECTIONS_ENTRANTES = 100;
const MAX_SESSIONS = 20;
const MAX_TOKENS_PAR_SESSION = 20;
const MAX_COMPTES_AUTH = 10;
const MAX_CODES_PAR_COMPTE_AUTH = 20;

const modeValidator = v.union(
  v.literal("conserver_les_deux"),
  v.literal("conserver_a"),
  v.literal("conserver_b"),
);
type Mode = "conserver_les_deux" | "conserver_a" | "conserver_b";

const compteResultatValidator = v.union(
  v.literal("conserve"),
  v.literal("desactive"),
  v.literal("staff_conserve"),
);
type CompteResultat = "conserve" | "desactive" | "staff_conserve";

const personneVueValidator = v.object({
  id: v.id("abo_personnes"),
  nom: v.string(),
  prenom: v.string(),
  licence: v.union(v.string(), v.null()),
});
const dossierVueValidator = v.object({
  id: v.id("abo_dossiers"),
  email: v.string(),
  compte: v.union(v.literal("public"), v.literal("staff")),
  personnes: v.array(personneVueValidator),
});
const notificationPlanifieeValidator = v.object({
  role: v.union(v.literal("dossier_a"), v.literal("dossier_b")),
  destinataire: v.string(),
  statut: v.literal("a_envoyer"),
});

type Ctx = QueryCtx | MutationCtx;
type Charge = Awaited<ReturnType<typeof chargerConflit>>;

function erreur(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

async function prendreBorne<T>(promise: Promise<T[]>, max: number, libelle: string): Promise<T[]> {
  const rows = await promise;
  if (rows.length > max) erreur("REPARTITION_VOLUME_DEPASSE", `${libelle} dépasse la limite de ${max}.`);
  return rows;
}

async function chargerConflit(
  ctx: Ctx,
  personneAId: Id<"abo_personnes">,
  personneBId: Id<"abo_personnes">,
) {
  if (personneAId === personneBId) erreur("REPARTITION_IDENTIQUE", "Choisissez deux personnes distinctes.");
  const [personneA, personneB] = await Promise.all([ctx.db.get(personneAId), ctx.db.get(personneBId)]);
  if (!personneA || !personneB) erreur("REPARTITION_PERSONNE_INTROUVABLE", "Une personne du conflit est introuvable.");
  if (personneA.dossier_id === personneB.dossier_id) {
    erreur("REPARTITION_MEME_DOSSIER", "Les deux personnes appartiennent déjà au même dossier.");
  }
  const [dossierA, dossierB] = await Promise.all([ctx.db.get(personneA.dossier_id), ctx.db.get(personneB.dossier_id)]);
  if (!dossierA || !dossierB) erreur("REPARTITION_DOSSIER_INTROUVABLE", "Un dossier du conflit est introuvable.");
  if (dossierA.owner_id === dossierB.owner_id) {
    erreur("REPARTITION_MEME_COMPTE", "Ces deux dossiers appartiennent déjà au même compte.");
  }
  const licence = personneA.licence ?? personneB.licence;
  if (!licence || (personneA.licence && personneB.licence && personneA.licence !== personneB.licence)) {
    erreur("REPARTITION_LICENCE_INVALIDE", "La résolution doit provenir d'un conflit sur une même licence.");
  }

  const [personnesA, personnesB, reservationsA, reservationsB,
    messagesA, messagesB, logsA, logsB, historiquesA, historiquesB,
    redirectionsA, redirectionsB, settingsA, settingsB, porteursLicence, scrapLicence] = await Promise.all([
    prendreBorne(ctx.db.query("abo_personnes").withIndex("by_dossier", q => q.eq("dossier_id", dossierA._id)).take(MAX_PERSONNES + 1), MAX_PERSONNES, "Le dossier A"),
    prendreBorne(ctx.db.query("abo_personnes").withIndex("by_dossier", q => q.eq("dossier_id", dossierB._id)).take(MAX_PERSONNES + 1), MAX_PERSONNES, "Le dossier B"),
    prendreBorne(ctx.db.query("abo_test_reservations").withIndex("by_personne", q => q.eq("personne_id", personneA._id)).take(MAX_RESERVATIONS + 1), MAX_RESERVATIONS, "Les réservations de la fiche A"),
    prendreBorne(ctx.db.query("abo_test_reservations").withIndex("by_personne", q => q.eq("personne_id", personneB._id)).take(MAX_RESERVATIONS + 1), MAX_RESERVATIONS, "Les réservations de la fiche B"),
    prendreBorne(ctx.db.query("abo_messages").withIndex("by_dossier", q => q.eq("dossier_id", dossierA._id)).take(MAX_MESSAGES + 1), MAX_MESSAGES, "Les messages du dossier A"),
    prendreBorne(ctx.db.query("abo_messages").withIndex("by_dossier", q => q.eq("dossier_id", dossierB._id)).take(MAX_MESSAGES + 1), MAX_MESSAGES, "Les messages du dossier B"),
    prendreBorne(ctx.db.query("abo_email_log").withIndex("by_dossier", q => q.eq("dossier_id", dossierA._id)).take(MAX_LOGS + 1), MAX_LOGS, "Les journaux email du dossier A"),
    prendreBorne(ctx.db.query("abo_email_log").withIndex("by_dossier", q => q.eq("dossier_id", dossierB._id)).take(MAX_LOGS + 1), MAX_LOGS, "Les journaux email du dossier B"),
    prendreBorne(ctx.db.query("abo_demandes_supprimees").withIndex("by_owner", q => q.eq("owner_id", dossierA.owner_id)).take(MAX_HISTORIQUES + 1), MAX_HISTORIQUES, "Les historiques du dossier A"),
    prendreBorne(ctx.db.query("abo_demandes_supprimees").withIndex("by_owner", q => q.eq("owner_id", dossierB.owner_id)).take(MAX_HISTORIQUES + 1), MAX_HISTORIQUES, "Les historiques du dossier B"),
    prendreBorne(ctx.db.query("abo_fusion_redirections_email").withIndex("by_dossier_destination_id", q => q.eq("dossier_destination_id", dossierA._id)).take(MAX_REDIRECTIONS_ENTRANTES + 1), MAX_REDIRECTIONS_ENTRANTES, "Les redirections vers le dossier A"),
    prendreBorne(ctx.db.query("abo_fusion_redirections_email").withIndex("by_dossier_destination_id", q => q.eq("dossier_destination_id", dossierB._id)).take(MAX_REDIRECTIONS_ENTRANTES + 1), MAX_REDIRECTIONS_ENTRANTES, "Les redirections vers le dossier B"),
    ctx.db.query("userSettings").withIndex("by_userId", q => q.eq("userId", dossierA.owner_id)).first(),
    ctx.db.query("userSettings").withIndex("by_userId", q => q.eq("userId", dossierB.owner_id)).first(),
    ctx.db.query("abo_personnes").withIndex("by_licence", q => q.eq("licence", licence)).take(3),
    ctx.db.query("abo_abonnes_scrap").withIndex("by_licence", q => q.eq("licence", licence)).first(),
  ]);

  const idsConflit = new Set([personneA._id, personneB._id]);
  if (porteursLicence.some(personne => !idsConflit.has(personne._id))) {
    erreur("REPARTITION_LICENCE_MULTIPLE", "Cette licence est aussi portée par une troisième personne. Corrigez ce conflit avant de continuer.");
  }
  if (reservationsA.length + reservationsB.length > MAX_RESERVATIONS) {
    erreur("REPARTITION_VOLUME_FINAL_DEPASSE", `La fiche finale dépasserait la limite de ${MAX_RESERVATIONS} réservations.`);
  }
  const doubleReservationActive =
    reservationsA.some(r => r.statut === "active") && reservationsB.some(r => r.statut === "active");
  return {
    personneA, personneB, dossierA, dossierB, licence, personnesA, personnesB,
    reservationsA, reservationsB, messagesA, messagesB, logsA, logsB,
    historiquesA, historiquesB, redirectionsA, redirectionsB, settingsA, settingsB,
    scrapLicence, doubleReservationActive,
  };
}

function revision(charge: Charge): string {
  const json = JSON.stringify(charge);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return `${json.length}-${(hash >>> 0).toString(16)}`;
}

function personneVue(personne: Doc<"abo_personnes">) {
  return { id: personne._id, nom: personne.nom, prenom: personne.prenom, licence: personne.licence ?? null };
}

function dossierVue(
  dossier: Doc<"abo_dossiers">,
  personnes: Doc<"abo_personnes">[],
  doublonId: Id<"abo_personnes">,
  staff: boolean,
) {
  return {
    id: dossier._id,
    email: dossier.email,
    compte: staff ? "staff" as const : "public" as const,
    personnes: personnes.filter(personne => personne._id !== doublonId).map(personneVue),
  };
}

export const getApercuRepartitionDossiers = authenticatedQuery({
  args: { personneAId: v.id("abo_personnes"), personneBId: v.id("abo_personnes") },
  returns: v.object({
    revision: v.string(),
    licenceDeclencheur: v.string(),
    dossierA: dossierVueValidator,
    dossierB: dossierVueValidator,
    personneDoublon: v.object({
      idLogique: v.id("abo_personnes"),
      optionA: personneVueValidator,
      optionB: personneVueValidator,
    }),
    alertes: v.array(v.object({ code: v.string(), message: v.string() })),
  }),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const charge = await chargerConflit(ctx, args.personneAId, args.personneBId);
    return {
      revision: revision(charge),
      licenceDeclencheur: charge.licence,
      dossierA: dossierVue(charge.dossierA, charge.personnesA, charge.personneA._id, Boolean(charge.settingsA)),
      dossierB: dossierVue(charge.dossierB, charge.personnesB, charge.personneB._id, Boolean(charge.settingsB)),
      personneDoublon: {
        idLogique: charge.personneA._id,
        optionA: personneVue(charge.personneA),
        optionB: personneVue(charge.personneB),
      },
      alertes: charge.doubleReservationActive
        ? [{ code: "DOUBLE_RESERVATION_ACTIVE", message: "Les deux fiches du doublon ont une réservation active. Annulez-en une avant de continuer." }]
        : [],
    };
  },
});

function statutRollup(personnes: Doc<"abo_personnes">[]): Doc<"abo_dossiers">["statut_dossier"] {
  const etats = personnes.map(personne => personne.etape_validation);
  if (etats.some(etat => etat === "en_attente")) return "nouvelle_demande";
  if (etats.some(etat => etat === "validee")) return "validee";
  if (etats.some(etat => etat === "liste_attente")) return "liste_attente";
  return "refusee";
}

function dossierConserve(mode: Mode, cote: "a" | "b"): boolean {
  return mode === "conserver_les_deux" || mode === `conserver_${cote}`;
}

function texteComposition(email: string, personnes: Doc<"abo_personnes">[]): string {
  const lignes = personnes.map(personne => `- ${personne.prenom} ${personne.nom}${personne.licence ? ` — licence ${personne.licence}` : ""}`);
  return `Dossier ${email}\n${lignes.join("\n")}`;
}

export const resoudreConflitDossiers = authenticatedMutation({
  args: {
    personneAId: v.id("abo_personnes"),
    personneBId: v.id("abo_personnes"),
    revision: v.string(),
    mode: modeValidator,
    affectations: v.array(v.object({ personneId: v.id("abo_personnes"), dossierId: v.id("abo_dossiers") })),
  },
  returns: v.object({
    resolutionId: v.id("abo_fusions_dossiers"),
    mode: modeValidator,
    dossiersConserves: v.array(v.id("abo_dossiers")),
    dossierSupprimeId: v.union(v.id("abo_dossiers"), v.null()),
    personneDoublonConserveeId: v.id("abo_personnes"),
    personnesDeplacees: v.number(),
    reservationsReaffectees: v.number(),
    messagesReaffectes: v.number(),
    logsReaffectes: v.number(),
    historiquesReaffectes: v.number(),
    compteA: compteResultatValidator,
    compteB: compteResultatValidator,
    notificationsPlanifiees: v.number(),
    notifications: v.array(notificationPlanifieeValidator),
  }),
  handler: async (ctx, args) => {
    const admin = await requireAboAdmin(ctx);
    const charge = await chargerConflit(ctx, args.personneAId, args.personneBId);
    if (revision(charge) !== args.revision) {
      erreur("REPARTITION_REVISION_OBSOLETE", "Les dossiers ont changé depuis l'aperçu. Rechargez avant de confirmer.");
    }
    if (charge.doubleReservationActive) {
      erreur("REPARTITION_RESERVATIONS_ACTIVES", "Les deux fiches du doublon ont une réservation active.");
    }

    const conserveA = dossierConserve(args.mode, "a");
    const conserveB = dossierConserve(args.mode, "b");
    const personnesLogiques = [
      charge.personneA._id,
      ...charge.personnesA.filter(p => p._id !== charge.personneA._id).map(p => p._id),
      ...charge.personnesB.filter(p => p._id !== charge.personneB._id).map(p => p._id),
    ];
    if (args.affectations.length !== personnesLogiques.length) {
      erreur("REPARTITION_AFFECTATIONS_INCOMPLETES", "Chaque personne doit être reliée à un dossier.");
    }
    const affectations = new Map<Id<"abo_personnes">, Id<"abo_dossiers">>();
    const idsAttendus = new Set(personnesLogiques);
    for (const affectation of args.affectations) {
      if (!idsAttendus.has(affectation.personneId) || affectations.has(affectation.personneId)) {
        erreur("REPARTITION_AFFECTATIONS_INVALIDES", "Une affectation est inconnue ou fournie plusieurs fois.");
      }
      const versA = affectation.dossierId === charge.dossierA._id;
      const versB = affectation.dossierId === charge.dossierB._id;
      if ((!versA && !versB) || (versA && !conserveA) || (versB && !conserveB)) {
        erreur("REPARTITION_DOSSIER_NON_CONSERVE", "Une personne ne peut pas être affectée à un dossier supprimé.");
      }
      affectations.set(affectation.personneId, affectation.dossierId);
    }
    if (personnesLogiques.some(id => !affectations.has(id))) {
      erreur("REPARTITION_AFFECTATIONS_INCOMPLETES", "Chaque personne doit être reliée à un dossier.");
    }
    const compteA = [...affectations.values()].filter(id => id === charge.dossierA._id).length;
    const compteB = [...affectations.values()].filter(id => id === charge.dossierB._id).length;
    if ((conserveA && compteA === 0) || (conserveB && compteB === 0)) {
      erreur("REPARTITION_DOSSIER_VIDE", "Chaque dossier conservé doit contenir au moins une personne.");
    }

    const dossierDoublonId = affectations.get(charge.personneA._id)!;
    const conserverFicheA = dossierDoublonId === charge.dossierA._id;
    const personneConservee = conserverFicheA ? charge.personneA : charge.personneB;
    const personneSupprimee = conserverFicheA ? charge.personneB : charge.personneA;
    const reservationsConservees = conserverFicheA ? charge.reservationsA : charge.reservationsB;
    const reservationsSupprimees = conserverFicheA ? charge.reservationsB : charge.reservationsA;
    if (reservationsConservees.length + reservationsSupprimees.length > MAX_RESERVATIONS) {
      erreur("REPARTITION_VOLUME_FINAL_DEPASSE", `La fiche finale dépasserait la limite de ${MAX_RESERVATIONS} réservations.`);
    }

    let personnesDeplacees = 0;
    for (const personne of [...charge.personnesA, ...charge.personnesB]) {
      if (personne._id === charge.personneA._id || personne._id === charge.personneB._id) continue;
      const cible = affectations.get(personne._id)!;
      if (personne.dossier_id !== cible) {
        const patch = { dossier_id: cible };
        if (champsModifies(personne, patch)) await ctx.db.patch(personne._id, patch);
        personnesDeplacees += 1;
      }
    }
    if (personneConservee.dossier_id !== dossierDoublonId) personnesDeplacees += 1;
    const patchDoublon = {
      dossier_id: dossierDoublonId,
      licence: charge.licence,
      licence_statut: "annuaire_valide" as const,
      etape_licence: true,
      ...(charge.scrapLicence ? champsPersonneDepuisScrap(charge.scrapLicence) : {}),
    };
    if (champsModifies(personneConservee, patchDoublon)) await ctx.db.patch(personneConservee._id, patchDoublon);
    for (const reservation of reservationsSupprimees) {
      const patch = { personne_id: personneConservee._id };
      if (champsModifies(reservation, patch)) await ctx.db.patch(reservation._id, patch);
    }
    await ctx.db.delete(personneSupprimee._id);

    const dossierSupprime = conserveA ? (conserveB ? null : charge.dossierB) : charge.dossierA;
    const dossierDestination = dossierSupprime
      ? (dossierSupprime._id === charge.dossierA._id ? charge.dossierB : charge.dossierA)
      : null;
    const emailSupprime = dossierSupprime ? canoniserEmailUnique(dossierSupprime.email) : null;
    const emailDestination = dossierDestination ? canoniserEmailUnique(dossierDestination.email) : null;
    if (emailSupprime && emailDestination && emailSupprime === emailDestination) {
      erreur("REPARTITION_EMAIL_IDENTIQUE", "Les deux dossiers utilisent la même adresse. Corrigez leurs comptes avant de supprimer un dossier.");
    }
    const sourceCote = dossierSupprime?._id === charge.dossierA._id ? "a" : "b";
    const sourceMessages = sourceCote === "a" ? charge.messagesA : charge.messagesB;
    const sourceLogs = sourceCote === "a" ? charge.logsA : charge.logsB;
    const sourceHistoriques = sourceCote === "a" ? charge.historiquesA : charge.historiquesB;
    const sourceRedirections = sourceCote === "a" ? charge.redirectionsA : charge.redirectionsB;
    const destinationRedirections = sourceCote === "a" ? charge.redirectionsB : charge.redirectionsA;
    const sourceSettings = sourceCote === "a" ? charge.settingsA : charge.settingsB;
    // Un compte staff n'est pas supprimé : ses retraits historiques restent
    // donc attachés à son propriétaire, même si son dossier public disparaît.
    const historiquesATransferer = sourceSettings ? [] : sourceHistoriques;

    let messagesReaffectes = 0;
    let logsReaffectes = 0;
    let historiquesReaffectes = 0;
    if (dossierSupprime && dossierDestination) {
      if (sourceMessages.length + (sourceCote === "a" ? charge.messagesB : charge.messagesA).length > MAX_MESSAGES ||
          sourceLogs.length + (sourceCote === "a" ? charge.logsB : charge.logsA).length > MAX_LOGS ||
          historiquesATransferer.length + (sourceCote === "a" ? charge.historiquesB : charge.historiquesA).length > MAX_HISTORIQUES ||
          sourceRedirections.length + destinationRedirections.length + 1 > MAX_REDIRECTIONS_ENTRANTES) {
        erreur("REPARTITION_VOLUME_FINAL_DEPASSE", "Le dossier final contiendrait trop d'historique pour une résolution atomique sûre.");
      }
      for (const message of sourceMessages) {
        const patch = { dossier_id: dossierDestination._id };
        if (champsModifies(message, patch)) await ctx.db.patch(message._id, patch);
      }
      for (const log of sourceLogs) {
        const patch = { dossier_id: dossierDestination._id };
        if (champsModifies(log, patch)) await ctx.db.patch(log._id, patch);
      }
      for (const historique of historiquesATransferer) {
        const patch = { owner_id: dossierDestination.owner_id };
        if (champsModifies(historique, patch)) await ctx.db.patch(historique._id, patch);
      }
      for (const redirection of sourceRedirections) {
        const patch = {
          dossier_destination_id: dossierDestination._id,
          email_destination: canoniserEmailUnique(dossierDestination.email),
        };
        if (champsModifies(redirection, patch)) await ctx.db.patch(redirection._id, patch);
      }
      messagesReaffectes = sourceMessages.length;
      logsReaffectes = sourceLogs.length;
      historiquesReaffectes = historiquesATransferer.length;
    }

    const now = new Date().toISOString();
    const fichesFinales = [...charge.personnesA, ...charge.personnesB]
      .filter(personne => personne._id !== personneSupprimee._id)
      .map(personne => personne._id === personneConservee._id ? { ...personne, ...patchDoublon } : {
        ...personne,
        dossier_id: affectations.get(personne._id) ?? personne.dossier_id,
      }) as Doc<"abo_personnes">[];
    for (const dossier of [charge.dossierA, charge.dossierB]) {
      if ((dossier._id === charge.dossierA._id && !conserveA) || (dossier._id === charge.dossierB._id && !conserveB)) continue;
      const personnes = fichesFinales.filter(personne => personne.dossier_id === dossier._id);
      const statut = statutRollup(personnes);
      const patch = {
        statut_dossier: statut,
        date_validation: statut === "validee" && !dossier.date_validation ? now : dossier.date_validation,
      };
      if (champsModifies(dossier, patch)) await ctx.db.patch(dossier._id, patch);
    }

    const compteAResultat: CompteResultat = conserveA ? "conserve" : (charge.settingsA ? "staff_conserve" : "desactive");
    const compteBResultat: CompteResultat = conserveB ? "conserve" : (charge.settingsB ? "staff_conserve" : "desactive");
    const resolutionId = await ctx.db.insert("abo_fusions_dossiers", {
      licence_declencheur: charge.licence,
      mode_resolution: args.mode,
      dossier_a_id: charge.dossierA._id,
      dossier_b_id: charge.dossierB._id,
      owner_a_id: charge.dossierA.owner_id,
      owner_b_id: charge.dossierB.owner_id,
      email_a: charge.dossierA.email,
      email_b: charge.dossierB.email,
      dossier_supprime_id: dossierSupprime?._id,
      personne_a_doublon_id: charge.personneA._id,
      personne_b_doublon_id: charge.personneB._id,
      personne_conservee_id: personneConservee._id,
      affectations_json: JSON.stringify(args.affectations),
      compte_a: compteAResultat,
      compte_b: compteBResultat,
      personnes_reaffectees: personnesDeplacees,
      reservations_reaffectees: reservationsSupprimees.length,
      messages_reaffectes: messagesReaffectes,
      logs_reaffectes: logsReaffectes,
      historiques_reaffectes: historiquesReaffectes,
      resolue_le: now,
      resolue_par: admin.userId,
    });

    if (dossierSupprime && dossierDestination) {
      const dejaRedirige = await ctx.db.query("abo_fusion_redirections_email")
        .withIndex("by_email_supprime", q => q.eq("email_supprime", emailSupprime!)).take(1);
      if (dejaRedirige.length > 0) erreur("REPARTITION_DEJA_EFFECTUEE", "L'adresse du dossier supprimé est déjà redirigée.");
      await ctx.db.insert("abo_fusion_redirections_email", {
        email_supprime: emailSupprime!,
        email_destination: emailDestination!,
        dossier_destination_id: dossierDestination._id,
        fusion_id: resolutionId,
        created_at: now,
      });
    }

    const notifications = [
      { role: "dossier_a" as const, destinataire: charge.dossierA.email, statut: "a_envoyer" as const },
      { role: "dossier_b" as const, destinataire: charge.dossierB.email, statut: "a_envoyer" as const },
    ];
    for (const notification of notifications) {
      const coteA = notification.role === "dossier_a";
      const conserve = coteA ? conserveA : conserveB;
      const dossier = coteA ? charge.dossierA : charge.dossierB;
      const composition = conserve
        ? texteComposition(dossier.email, fichesFinales.filter(personne => personne.dossier_id === dossier._id))
        : texteComposition(dossierDestination!.email, fichesFinales.filter(personne => personne.dossier_id === dossierDestination!._id));
      const sujet = "Mise à jour de votre dossier d'abonnement escalade";
      const contenu = conserve
        ? `Bonjour,\n\nLa répartition liée au conflit de licence a été effectuée. Votre dossier est conservé.\n\n${composition}\n\nSportivement,\nLa commission escalade du CAF La Roche / Bonneville`
        : `Bonjour,\n\nLa répartition liée au conflit de licence a été effectuée. Votre dossier a été regroupé avec celui accessible par ${dossierDestination!.email}.\n\n${composition}\n\nSportivement,\nLa commission escalade du CAF La Roche / Bonneville`;
      const notificationId = await ctx.db.insert("abo_fusion_notifications", {
        fusion_id: resolutionId,
        destinataire: notification.destinataire,
        role_destinataire: notification.role,
        sujet,
        contenu,
        statut: "a_envoyer",
        tentatives: 0,
      });
      await ctx.scheduler.runAfter(0, internal.abo.fusionsDossiers.envoyerNotificationFusion, { notificationId });
    }

    if (dossierSupprime) {
      const profile = await ctx.db.query("abo_profiles").withIndex("by_userId", q => q.eq("userId", dossierSupprime.owner_id)).first();
      if (profile) await ctx.db.delete(profile._id);
      await ctx.db.delete(dossierSupprime._id);
      if (!sourceSettings) await supprimerComptePublic(ctx, dossierSupprime.owner_id);
    }

    await programmerRafraichissementCompteurPublic(ctx);
    return {
      resolutionId,
      mode: args.mode,
      dossiersConserves: [
        ...(conserveA ? [charge.dossierA._id] : []),
        ...(conserveB ? [charge.dossierB._id] : []),
      ],
      dossierSupprimeId: dossierSupprime?._id ?? null,
      personneDoublonConserveeId: personneConservee._id,
      personnesDeplacees,
      reservationsReaffectees: reservationsSupprimees.length,
      messagesReaffectes,
      logsReaffectes,
      historiquesReaffectes,
      compteA: compteAResultat,
      compteB: compteBResultat,
      notificationsPlanifiees: notifications.length,
      notifications,
    };
  },
});

async function supprimerComptePublic(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const sessions = await prendreBorne(ctx.db.query("authSessions").withIndex("userId", q => q.eq("userId", userId)).take(MAX_SESSIONS + 1), MAX_SESSIONS, "Les sessions du compte supprimé");
  for (const session of sessions) {
    const tokens = await prendreBorne(ctx.db.query("authRefreshTokens").withIndex("sessionId", q => q.eq("sessionId", session._id)).take(MAX_TOKENS_PAR_SESSION + 1), MAX_TOKENS_PAR_SESSION, "Les jetons du compte supprimé");
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
  const comptes = await prendreBorne(ctx.db.query("authAccounts").withIndex("userIdAndProvider", q => q.eq("userId", userId)).take(MAX_COMPTES_AUTH + 1), MAX_COMPTES_AUTH, "Les identités du compte supprimé");
  for (const compte of comptes) {
    const codes = await prendreBorne(ctx.db.query("authVerificationCodes").withIndex("accountId", q => q.eq("accountId", compte._id)).take(MAX_CODES_PAR_COMPTE_AUTH + 1), MAX_CODES_PAR_COMPTE_AUTH, "Les codes du compte supprimé");
    for (const code of codes) await ctx.db.delete(code._id);
    await ctx.db.delete(compte._id);
  }
}

export const chargerNotificationFusion = internalQuery({
  args: { notificationId: v.id("abo_fusion_notifications") },
  returns: v.union(v.null(), v.object({ destinataire: v.string(), sujet: v.string(), contenu: v.string() })),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.statut === "envoye") return null;
    return { destinataire: notification.destinataire, sujet: notification.sujet, contenu: notification.contenu };
  },
});

export const terminerNotificationFusion = internalMutation({
  args: { notificationId: v.id("abo_fusion_notifications"), succes: v.boolean(), erreur: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.statut === "envoye") return null;
    const patch = args.succes
      ? { statut: "envoye" as const, tentatives: notification.tentatives + 1, envoye_le: new Date().toISOString(), derniere_erreur: undefined }
      : { statut: "echec" as const, tentatives: notification.tentatives + 1, derniere_erreur: (args.erreur ?? "Échec SMTP").slice(0, 500) };
    if (champsModifies(notification, patch)) await ctx.db.patch(notification._id, patch);
    return null;
  },
});

export const envoyerNotificationFusion = internalAction({
  args: { notificationId: v.id("abo_fusion_notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notification: { destinataire: string; sujet: string; contenu: string } | null =
      await ctx.runQuery(internal.abo.fusionsDossiers.chargerNotificationFusion, args);
    if (!notification) return null;
    try {
      await ctx.runAction(internal.email.sendAboEmail, {
        to: notification.destinataire,
        subject: notification.sujet,
        text: notification.contenu,
      });
      await ctx.runMutation(internal.abo.fusionsDossiers.terminerNotificationFusion, { notificationId: args.notificationId, succes: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Échec SMTP";
      await ctx.runMutation(internal.abo.fusionsDossiers.terminerNotificationFusion, { notificationId: args.notificationId, succes: false, erreur: message });
    }
    return null;
  },
});
