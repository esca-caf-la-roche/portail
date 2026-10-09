import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "./customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTile } from "./access";
import { cleNomPrenom, normaliserTexte } from "./competitionModel";
import { verifierSaison } from "./competition";

const WEBHOOK_URL = "https://n8n.jpcloudkit.fr/webhook/partenariat-arkose";
const MAX_ITEMS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 90_000;
const itemValidator = v.object({ nom: v.string(), prenom: v.string() });

type Item = { nom: string; prenom: string };

function invalid(message: string): never { throw new ConvexError({ code: "ARKOSE_WEBHOOK_JSON_INVALIDE", message }); }

function lireIdentite(row: Record<string, unknown>, field: "nom" | "prenom"): string {
  const keys = Object.keys(row).filter((candidate) => normaliserTexte(candidate) === field);
  if (keys.length > 1) invalid(`Le webhook Arkose contient plusieurs champs pour « ${field === "nom" ? "nom" : "prénom"} ».`);
  const value = keys.length === 1 ? row[keys[0]] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

export function validerReponseArkose(value: unknown): Item[] {
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    if (!value.trim()) return [];
    try { value = JSON.parse(value) as unknown; } catch { invalid("Le webhook Arkose n'a pas renvoyé un JSON valide."); }
  }
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid("Le webhook Arkose doit renvoyer au plus 1 000 signatures.");
  const uniques = new Map<string, Item>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`L'élément ${index + 1} doit être un objet JSON.`);
    const row = entry as Record<string, unknown>;
    const nom = lireIdentite(row, "nom");
    const prenom = lireIdentite(row, "prenom");
    if (!nom || !prenom || nom.length > 100 || prenom.length > 100) invalid(`L'élément ${index + 1} doit contenir un nom et un prénom de 100 caractères maximum.`);
    uniques.set(cleNomPrenom(nom, prenom), { nom, prenom });
  });
  return [...uniques.values()];
}

export const verifierAcces = internalQuery({
  args: { saison: v.string(), userId: v.id("users") }, returns: v.null(),
  handler: async (ctx, args) => { await requireTile(ctx, args.userId, "competition"); await verifierSaison(ctx, args.saison); return null; },
});

export const enregistrerLot = internalMutation({
  args: { saison: v.string(), items: v.array(itemValidator), userId: v.id("users") },
  returns: v.object({ queued: v.number(), autoLinked: v.number(), ignored: v.number() }),
  handler: async (ctx, args) => {
    if (args.items.length > 100) throw new ConvexError("Lot Arkose interne invalide.");
    // IO-BOUNDED: le registre Arkose est limité opérationnellement à 200 ambassadeurs par saison.
    const ambassadeurs = await ctx.db.query("competition_ambassadeurs").withIndex("by_saison", (q) => q.eq("saison", args.saison)).take(201);
    if (ambassadeurs.length > 200) throw new ConvexError("Le registre contient plus de 200 ambassadeurs : synchronisation refusée.");
    let queued = 0; let autoLinked = 0; let ignored = 0;
    for (const item of args.items) {
      const key = cleNomPrenom(item.nom, item.prenom);
      const existing = await ctx.db.query("competition_signatures_arkose").withIndex("by_saison_and_nomPrenomNormalise", (q) => q.eq("saison", args.saison).eq("nomPrenomNormalise", key)).unique();
      if (existing) { ignored++; continue; }
      const matches = ambassadeurs.filter((a) => cleNomPrenom(a.nom, a.prenom) === key);
      const signatureId = await ctx.db.insert("competition_signatures_arkose", { saison: args.saison, nom: item.nom, prenom: item.prenom, nomPrenomNormalise: key, statut: matches.length === 1 ? "lie" : "a_rapprocher", firstSeenAt: Date.now() });
      if (matches.length !== 1) { queued++; continue; }
      const ambassadeur = matches[0];
      await ctx.db.insert("competition_signatures_arkose_liens", { saison: args.saison, signatureId, ambassadeurId: ambassadeur._id, origine: "automatique", lieLe: Date.now() });
      if (!ambassadeur.partenariatSigne) await ctx.db.patch(ambassadeur._id, { partenariatSigne: true, revision: ambassadeur.revision + 1, updatedAt: Date.now(), updatedBy: args.userId });
      autoLinked++;
    }
    return { queued, autoLinked, ignored };
  },
});

export const synchroniser = authenticatedAction({
  args: { saison: v.string() }, returns: v.object({ recus: v.number(), queued: v.number(), autoLinked: v.number(), ignored: v.number() }),
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.competitionArkoseWebhook.verifierAcces, { saison: args.saison, userId: ctx.userId });
    const user = process.env.ABO_REGLEMENTS_WEBHOOK_USER;
    const password = process.env.ABO_REGLEMENTS_WEBHOOK_PASSWORD;
    if (!user || !password) throw new ConvexError({ code: "ARKOSE_WEBHOOK_CONFIGURATION", message: "Le webhook Arkose n'est pas configuré." });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let text: string;
    try {
      const response = await fetch(WEBHOOK_URL, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${user}:${password}`)}` } });
      if (!response.ok) throw new ConvexError({ code: "ARKOSE_WEBHOOK_HTTP", message: `Le webhook Arkose a répondu avec le statut ${response.status}.` });
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) invalid("La réponse du webhook Arkose est trop volumineuse.");
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalid("La réponse du webhook Arkose est trop volumineuse.");
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      const timeoutReached = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
      throw new ConvexError({ code: timeoutReached ? "ARKOSE_WEBHOOK_TIMEOUT" : "ARKOSE_WEBHOOK_INDISPONIBLE", message: timeoutReached ? "La synchronisation Arkose a dépassé 90 secondes." : "Le webhook Arkose est indisponible." });
    } finally { clearTimeout(timeout); }
    const items = validerReponseArkose(text); const total = { queued: 0, autoLinked: 0, ignored: 0 };
    for (let i = 0; i < items.length; i += 100) { const stats = await ctx.runMutation(internal.competitionArkoseWebhook.enregistrerLot, { saison: args.saison, items: items.slice(i, i + 100), userId: ctx.userId }); total.queued += stats.queued; total.autoLinked += stats.autoLinked; total.ignored += stats.ignored; }
    return { recus: items.length, ...total };
  },
});
