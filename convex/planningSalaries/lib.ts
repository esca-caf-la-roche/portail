import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getUserSettings, requireTile } from "../access";
import { canoniserEmailUnique } from "../emailValidation";

export const TILE = "planning_salaries_samedis" as const;
export const PLACEHOLDER_RESOURCE =
  "c_1885o4bj2rlv4gijgd278pfg9rub0@resource.calendar.google.com";
export const MAX_CRENEAUX_PAR_SAISON = 400;
// Le club compte quelques salariés ; cette borne protège la synchronisation
// multi-calendriers (un appel Google minimal par ressource et par saison).
export const MAX_SALARIES = 50;
export const MAX_OPERATIONS_PAR_SAISON = 1_000;

export function erreur(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

export function verifierSaison(saisonBrute: string): string {
  const saison = saisonBrute.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(saison);
  if (!match || Number(match[2]) !== (Number(match[1]) + 1) % 100) {
    throw erreur("PLANNING_SAISON_INVALIDE", "La saison doit être au format AAAA-AA.");
  }
  return saison;
}

export function bornesSaison(saisonBrute: string) {
  const saison = verifierSaison(saisonBrute);
  const annee = Number(saison.slice(0, 4));
  return {
    saison,
    dateDebut: `${annee}-09-01`,
    dateFin: `${annee + 1}-08-31`,
    timeMin: `${annee}-08-31T22:00:00.000Z`,
    timeMax: `${annee + 1}-08-31T22:00:00.000Z`,
  };
}

export function normaliserResource(resource: string): string {
  const valeur = resource.trim().toLowerCase();
  if (
    !valeur ||
    valeur.length > 320 ||
    !valeur.endsWith("@resource.calendar.google.com")
  ) {
    throw erreur("PLANNING_RESSOURCE_INVALIDE", "La ressource Google Calendar est invalide.");
  }
  return valeur;
}

export function normaliserPrenom(prenom: string): string {
  const valeur = prenom.trim().replace(/\s+/g, " ");
  if (!valeur || valeur.length > 80) {
    throw erreur("PLANNING_PRENOM_INVALIDE", "Le prénom est obligatoire et limité à 80 caractères.");
  }
  return valeur;
}

export function normaliserEmail(email: string): string {
  return canoniserEmailUnique(email);
}

export async function getSalarieParUserId(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"planning_salaries_annuaire"> | null> {
  const salarie = await ctx.db
    .query("planning_salaries_annuaire")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return salarie?.actif ? salarie : null;
}

export async function getIdentiteOptionnelle(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  const [settings, salarie] = await Promise.all([
    getUserSettings(ctx, userId),
    getSalarieParUserId(ctx, userId),
  ]);
  const gestionnaire = settings?.allowedTiles.includes(TILE) === true;
  return { gestionnaire, salarie };
}

export async function getIdentite(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  const identite = await getIdentiteOptionnelle(ctx, userId);
  const { gestionnaire, salarie } = identite;
  if (!gestionnaire && !salarie) {
    throw erreur("PLANNING_ACCES_REFUSE", "Ce compte n'a pas accès au planning des salariés.");
  }
  return identite;
}

export async function requireGestionnaire(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  return await requireTile(ctx, userId, TILE);
}
