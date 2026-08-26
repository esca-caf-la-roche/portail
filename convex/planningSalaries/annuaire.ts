import { ConvexError, v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { champsModifies } from "../dbUtils";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getIdentite,
  MAX_CRENEAUX_PAR_SAISON,
  MAX_SALARIES,
  normaliserEmail,
  normaliserPrenom,
  normaliserResource,
  requireGestionnaire,
} from "./lib";

const salariePublicValidator = v.object({
  _id: v.id("planning_salaries_annuaire"),
  prenom: v.string(),
  email: v.string(),
  resourceCalendarId: v.string(),
  actif: v.boolean(),
  compteLie: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const MAX_USERS_FALLBACK_EMAIL = 2_000;

async function refuserEmailsStaff(ctx: MutationCtx, emails: string[]) {
  const verifications = await Promise.all(emails.map(async (email) => ({
    email,
    participantSamedi: await ctx.db.query("samedis_participants")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
      .unique(),
    profilAbo: await ctx.db.query("abo_profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first(),
    user: await ctx.db.query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first(),
  })));
  if (verifications.some(({ participantSamedi, profilAbo }) => participantSamedi || profilAbo)) {
    throw new ConvexError(
      "Cette adresse appartient déjà à un autre espace isolé du portail.",
    );
  }

  const userIdsParEmail = new Map<string, Id<"users">>();
  for (const { email, user } of verifications) {
    if (user) userIdsParEmail.set(email, user._id);
  }
  if (verifications.some(({ user }) => !user)) {
    const users = await ctx.db.query("users").take(MAX_USERS_FALLBACK_EMAIL + 1);
    if (users.length > MAX_USERS_FALLBACK_EMAIL) {
      throw new ConvexError("Impossible de vérifier les comptes existants : migration des emails requise.");
    }
    for (const candidate of users) {
      try {
        const email = normaliserEmail(candidate.email ?? "");
        if (emails.includes(email)) userIdsParEmail.set(email, candidate._id);
      } catch { /* Les comptes historiques sans email exploitable sont ignorés. */ }
    }
  }
  for (const userId of userIdsParEmail.values()) {
    const settings = await ctx.db.query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId)).first();
    if (settings) {
      throw new ConvexError("Cette adresse appartient déjà au portail staff et ne peut pas être inscrite comme salarié isolé.");
    }
  }
}

async function refuserEmailStaff(ctx: MutationCtx, email: string) {
  await refuserEmailsStaff(ctx, [email]);
}

export const list = authenticatedQuery({
  args: {},
  returns: v.object({
    limite: v.number(),
    salaries: v.array(salariePublicValidator),
  }),
  handler: async (ctx) => {
    await requireGestionnaire(ctx, ctx.userId);
    const salaries = await ctx.db.query("planning_salaries_annuaire").take(MAX_SALARIES + 1);
    if (salaries.length > MAX_SALARIES) {
      throw new ConvexError("L'annuaire dépasse la limite prévue ; une pagination est nécessaire.");
    }
    return {
      limite: MAX_SALARIES,
      salaries: salaries
      .sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"))
      .map((salarie) => ({
        _id: salarie._id,
        prenom: salarie.prenom,
        email: salarie.email,
        resourceCalendarId: salarie.resourceCalendarId,
        actif: salarie.actif,
        compteLie: salarie.userId !== undefined,
        createdAt: salarie.createdAt,
        updatedAt: salarie.updatedAt,
      })),
    };
  },
});

export const listActifs = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    _id: v.id("planning_salaries_annuaire"),
    prenom: v.string(),
  })),
  handler: async (ctx) => {
    await getIdentite(ctx, ctx.userId);
    return (await ctx.db
      .query("planning_salaries_annuaire")
      .withIndex("by_actif", (q) => q.eq("actif", true))
      .take(MAX_SALARIES + 1))
      .sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"))
      .map(({ _id, prenom }) => ({ _id, prenom }));
  },
});

async function verifierUnicite(
  ctx: MutationCtx,
  emailNormalise: string,
  resourceNormalisee: string,
  ignorerId?: string,
) {
  const [parEmail, parRessource] = await Promise.all([
    ctx.db.query("planning_salaries_annuaire")
      .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", emailNormalise)).unique(),
    ctx.db.query("planning_salaries_annuaire")
      .withIndex("by_resourceCalendarIdNormalise", (q) => q.eq("resourceCalendarIdNormalise", resourceNormalisee)).unique(),
  ]);
  if (parEmail && parEmail._id !== ignorerId) throw new ConvexError("Cette adresse email est déjà inscrite.");
  if (parRessource && parRessource._id !== ignorerId) throw new ConvexError("Cette ressource Google est déjà utilisée.");
}

function dateParisAujourdhui(): string {
  const morceaux = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const valeurs = Object.fromEntries(morceaux.map((morceau) => [morceau.type, morceau.value]));
  return `${valeurs.year}-${valeurs.month}-${valeurs.day}`;
}

async function refuserModificationAvecAffectationFuture(
  ctx: MutationCtx,
  salarieId: Id<"planning_salaries_annuaire">,
) {
  const affectations = await ctx.db
    .query("planning_salaries_affectations")
    .withIndex("by_salarieId", (q) => q.eq("salarieId", salarieId))
    .take(MAX_CRENEAUX_PAR_SAISON + 1);
  if (affectations.length > MAX_CRENEAUX_PAR_SAISON) {
    throw new ConvexError("Trop d'affectations pour vérifier cette modification.");
  }
  const aujourdHui = dateParisAujourdhui();
  for (const affectation of affectations) {
    const creneau = affectation.date || !affectation.creneauId
      ? null
      : await ctx.db.get(affectation.creneauId);
    const date = affectation.date ?? creneau?.date;
    if (date && date >= aujourdHui) {
      throw new ConvexError(
        "Ce salarié possède encore une affectation à venir : retirez-la avant de modifier sa ressource ou de le désactiver.",
      );
    }
  }
}

type SaisieSalarie = {
  prenom: string;
  email: string;
  resourceCalendarId: string;
};

function normaliserSaisie(args: SaisieSalarie): SaisieSalarie {
  return {
    prenom: normaliserPrenom(args.prenom),
    email: normaliserEmail(args.email),
    resourceCalendarId: normaliserResource(args.resourceCalendarId),
  };
}

async function verifierCapaciteAnnuaire(ctx: MutationCtx, ajouts: number) {
  const salaries = await ctx.db
    .query("planning_salaries_annuaire")
    .take(MAX_SALARIES);
  if (ajouts < 1 || salaries.length + ajouts > MAX_SALARIES) {
    throw new ConvexError(
      `L'annuaire est limité à ${MAX_SALARIES} salariés. Réactivez ou modifiez une fiche existante avant d'en ajouter une nouvelle.`,
    );
  }
}

async function insererSalarie(ctx: MutationCtx, saisie: SaisieSalarie) {
  await verifierUnicite(ctx, saisie.email, saisie.resourceCalendarId);
  const now = Date.now();
  return await ctx.db.insert("planning_salaries_annuaire", {
    prenom: saisie.prenom,
    email: saisie.email,
    emailNormalise: saisie.email,
    resourceCalendarId: saisie.resourceCalendarId,
    resourceCalendarIdNormalise: saisie.resourceCalendarId,
    actif: true,
    createdAt: now,
    updatedAt: now,
  });
}

export const ajouter = authenticatedMutation({
  args: { prenom: v.string(), email: v.string(), resourceCalendarId: v.string() },
  returns: v.id("planning_salaries_annuaire"),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    await verifierCapaciteAnnuaire(ctx, 1);
    const saisie = normaliserSaisie(args);
    await refuserEmailStaff(ctx, saisie.email);
    return await insererSalarie(ctx, saisie);
  },
});

export const ajouterPlusieurs = authenticatedMutation({
  args: {
    salaries: v.array(v.object({
      prenom: v.string(),
      email: v.string(),
      resourceCalendarId: v.string(),
    })),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    await verifierCapaciteAnnuaire(ctx, args.salaries.length);
    const saisies = args.salaries.map(normaliserSaisie);
    await refuserEmailsStaff(ctx, saisies.map(({ email }) => email));
    for (const saisie of saisies) await insererSalarie(ctx, saisie);
    return saisies.length;
  },
});

export const modifier = authenticatedMutation({
  args: {
    salarieId: v.id("planning_salaries_annuaire"),
    prenom: v.string(),
    email: v.string(),
    resourceCalendarId: v.string(),
    actif: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const salarie = await ctx.db.get(args.salarieId);
    if (!salarie) throw new ConvexError("Salarié introuvable.");
    const prenom = normaliserPrenom(args.prenom);
    const email = normaliserEmail(args.email);
    const resourceCalendarId = normaliserResource(args.resourceCalendarId);
    await refuserEmailStaff(ctx, email);
    await verifierUnicite(ctx, email, resourceCalendarId, salarie._id);
    if (
      (salarie.actif && !args.actif) ||
      salarie.resourceCalendarIdNormalise !== resourceCalendarId
    ) {
      await refuserModificationAvecAffectationFuture(ctx, salarie._id);
    }
    const patch = {
      prenom,
      email,
      emailNormalise: email,
      resourceCalendarId,
      resourceCalendarIdNormalise: resourceCalendarId,
      actif: args.actif,
      userId: salarie.emailNormalise === email ? salarie.userId : undefined,
      updatedAt: Date.now(),
    };
    if (champsModifies(salarie, patch, ["updatedAt"])) await ctx.db.patch(salarie._id, patch);
    return null;
  },
});

export const supprimer = authenticatedMutation({
  args: { salarieId: v.id("planning_salaries_annuaire") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGestionnaire(ctx, ctx.userId);
    const salarie = await ctx.db.get(args.salarieId);
    if (!salarie) return null;
    // L'annuaire durable conserve l'historique saisonnier : « supprimer »
    // désactive la fiche et détache seulement son identité de connexion.
    if (salarie.actif) {
      await refuserModificationAvecAffectationFuture(ctx, salarie._id);
      await ctx.db.patch(salarie._id, {
        actif: false,
        userId: undefined,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
