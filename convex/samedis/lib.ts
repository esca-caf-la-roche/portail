import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireTile } from "../access";
import { canoniserEmailUnique } from "../emailValidation";

export const MAX_SAMEDIS_PAR_SAISON = 60;
export const MAX_PARTICIPANTS = 500;
export const DESTINATAIRE_SYNTHESE = "escalade@caflarochebonneville.fr";

export function tableauxEgaux<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((valeur, index) => valeur === b[index]);
}

export function erreur(code: string, message: string) {
  return new ConvexError({ code, message });
}

export function verifierSaison(saison: string): string {
  const valeur = saison.trim();
  if (!valeur || valeur.length > 30) {
    throw erreur("SAMEDIS_SAISON_INVALIDE", "La saison est invalide.");
  }
  return valeur;
}

export function verifierDateCivile(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw erreur("SAMEDIS_DATE_INVALIDE", "La date doit être au format AAAA-MM-JJ.");
  }
  const instant = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw erreur("SAMEDIS_DATE_INVALIDE", "La date indiquée n'existe pas.");
  }
  return date;
}

export function estSamedi(date: string): boolean {
  return new Date(`${verifierDateCivile(date)}T12:00:00Z`).getUTCDay() === 6;
}

export function enumererSamedis(dateDebut: string, dateFin: string): string[] {
  verifierDateCivile(dateDebut);
  verifierDateCivile(dateFin);
  const debut = new Date(`${dateDebut}T12:00:00Z`);
  const fin = new Date(`${dateFin}T12:00:00Z`);
  if (debut > fin) {
    throw erreur("SAMEDIS_PERIODE_INVALIDE", "La date de fin doit suivre la date de début.");
  }
  if (fin.getTime() - debut.getTime() > 400 * 86_400_000) {
    throw erreur("SAMEDIS_PERIODE_TROP_LONGUE", "La période ne peut pas dépasser 400 jours.");
  }
  while (debut.getUTCDay() !== 6) debut.setUTCDate(debut.getUTCDate() + 1);
  const dates: string[] = [];
  while (debut <= fin) {
    dates.push(debut.toISOString().slice(0, 10));
    debut.setUTCDate(debut.getUTCDate() + 7);
  }
  if (dates.length > MAX_SAMEDIS_PAR_SAISON) {
    throw erreur("SAMEDIS_VOLUME_INVALIDE", "La période contient trop de samedis.");
  }
  return dates;
}

export function texteCourt(valeur: string, libelle: string, max = 160): string {
  const resultat = valeur.trim();
  if (!resultat || resultat.length > max) {
    throw erreur("SAMEDIS_TEXTE_INVALIDE", `${libelle} est requis et limité à ${max} caractères.`);
  }
  return resultat;
}

export async function requireGestionnaire(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  await requireTile(ctx, userId, "samedis");
}

export interface SamediIdentity {
  userId: Id<"users">;
  gestionnaire: boolean;
  participant: Doc<"samedis_participants"> | null;
  email: string;
}

export async function getSamediIdentity(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<SamediIdentity | null> {
  const user = await ctx.db.get(userId);
  if (!user) return null;
  const settings = await ctx.db
    .query("userSettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  const participant = await ctx.db
    .query("samedis_participants")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return {
    userId,
    gestionnaire: settings?.allowedTiles.includes("samedis") === true,
    participant: participant?.actif ? participant : null,
    email: typeof user.email === "string" ? canoniserEmailUnique(user.email) : "",
  };
}

export async function requireParticipant(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"samedis_participants">> {
  const identity = await getSamediIdentity(ctx, userId);
  if (!identity?.participant) {
    throw erreur(
      "SAMEDIS_ACCES_REFUSE",
      "Votre adresse n'est pas autorisée pour les samedis après-midi.",
    );
  }
  return identity.participant;
}

export async function lireBorne<T>(
  promise: Promise<T[]>,
  limite: number,
  message: string,
): Promise<T[]> {
  const lignes = await promise;
  if (lignes.length > limite) throw erreur("SAMEDIS_VOLUME_DEPASSE", message);
  return lignes;
}
