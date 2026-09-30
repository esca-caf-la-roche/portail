/* eslint-disable @typescript-eslint/no-explicit-any --
   Les payloads de l'API HelloAsso (paiements, payeur, items…) ne sont pas typés :
   on les manipule en `any` de façon délibérée et bornée dans ce fichier. */
import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authenticatedAction } from "./customFunctions";
import { internal } from "./_generated/api";
import { champsModifies } from "./dbUtils";

// --- HELPERS ---
const HA_TOKEN_URL = "https://api.helloasso.com/oauth2/token";
const HA_API_BASE = "https://api.helloasso.com/v5";

const FORM_TYPE_MAP: Record<string, string> = {
  evenements: "Event",
  adhesions: "Membership",
  collectes: "CrowdFunding",
  boutiques: "Shop",
  paiements: "PaymentForm",
};

function parseHaUrl(
  raw: string
): { orgSlug: string; formType: string; formSlug: string } | null {
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[0] !== "associations") return null;
    const orgSlug = parts[1];
    const formType = FORM_TYPE_MAP[parts[2]];
    const formSlug = parts[3];
    if (!formType || !formSlug) return null;
    return { orgSlug, formType, formSlug };
  } catch {
    return null;
  }
}

async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const res = await fetch(HA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HelloAsso token (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json as any).access_token as string;
}

async function fetchAllPayments(
  token: string,
  orgSlug: string,
  formType: string,
  formSlug: string
): Promise<any[]> {
  const all: any[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const url = new URL(
      `${HA_API_BASE}/organizations/${orgSlug}/forms/${formType}/${formSlug}/payments`
    );
    url.searchParams.set("pageSize", "100");
    if (continuationToken) {
      url.searchParams.set("continuationToken", continuationToken);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `HelloAsso payments [${formSlug}] (${res.status}): ${body.slice(0, 200)}`
      );
    }
    const json = (await res.json()) as any;

    if (!json.data || json.data.length === 0) {
      break;
    }

    const validPayments = json.data.filter(
      (p: any) => p.state !== "Refused" && p.state !== "Canceled"
    );
    all.push(...validPayments);

    continuationToken = json.pagination?.continuationToken;
  } while (continuationToken);

  return all;
}

function extractPhone(items?: any[]): string | null {
  if (!items?.length) return null;
  for (const item of items) {
    for (const cf of item.customFields ?? []) {
      const name = cf.name.toLowerCase();
      if (
        (name.includes("téléphone") ||
          name.includes("telephone") ||
          name.includes("phone") ||
          name.includes("mobile") ||
          name.includes("portable")) &&
        cf.answer
      ) {
        return cf.answer;
      }
    }
  }
  return null;
}

// --- QUERY INTERNE : liens configurés ---
export const getLinksInternal = internalQuery({
  args: { linkIds: v.optional(v.array(v.id("helloasso_links"))) },
  handler: async (ctx, args) => {
    if (args.linkIds) {
      const links = await Promise.all(args.linkIds.map((id) => ctx.db.get(id)));
      return links.filter((link) => link !== null);
    }
    return await ctx.db.query("helloasso_links").collect();
  },
});

// --- MUTATION INTERNE : upsert des dossiers (préserve le statut local) ---
export const upsertDossiers = internalMutation({
  args: {
    dossiers: v.array(
      v.object({
        dossier_id: v.string(),
        helloasso_link_id: v.id("helloasso_links"),
        first_name: v.string(),
        last_name: v.string(),
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        payer_first_name: v.string(),
        payer_last_name: v.string(),
        payer_email: v.string(),
        total_amount: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    let count = 0;
    for (const d of args.dossiers) {
      const existing = await ctx.db
        .query("dossiers")
        .withIndex("by_dossier_id", (q) => q.eq("dossier_id", d.dossier_id))
        .first();

      if (existing) {
        // On ne touche PAS aux champs locaux (local_status, comment, updated_*).
        // Patch seulement si un champ HelloAsso a réellement changé : sinon on
        // évite un write inutile ET la re-lecture temps réel de la table.
        if (champsModifies(existing, d)) {
          await ctx.db.patch(existing._id, {
            helloasso_link_id: d.helloasso_link_id,
            first_name: d.first_name,
            last_name: d.last_name,
            email: d.email,
            phone: d.phone,
            payer_first_name: d.payer_first_name,
            payer_last_name: d.payer_last_name,
            payer_email: d.payer_email,
            total_amount: d.total_amount,
          });
        }
      } else {
        await ctx.db.insert("dossiers", d);
      }
      count++;
    }
    return count;
  },
});

// --- MUTATION INTERNE : upsert des transactions ---
export const upsertTransactions = internalMutation({
  args: {
    transactions: v.array(
      v.object({
        helloasso_payment_id: v.string(),
        dossier_id: v.string(),
        amount: v.number(),
        payment_date: v.string(),
        helloasso_status: v.string(),
        synced_at: v.string(),
        payment_receipt_url: v.optional(v.string()),
        fiscal_receipt_url: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    let count = 0;
    for (const t of args.transactions) {
      const existing = await ctx.db
        .query("helloasso_transactions")
        .withIndex("by_payment_id", (q) =>
          q.eq("helloasso_payment_id", t.helloasso_payment_id)
        )
        .first();
      if (existing) {
        // `synced_at` change à chaque sync : on l'ignore pour ne réécrire que
        // sur un vrai changement (montant, statut, reçus…).
        if (champsModifies(existing, t, ["synced_at"])) {
          await ctx.db.patch(existing._id, t);
        }
      } else {
        await ctx.db.insert("helloasso_transactions", t);
      }
      count++;
    }
    return count;
  },
});

// --- ACTION : synchronisation HelloAsso → dossiers + transactions ---
// Cœur de la synchro, SANS garde d'auth : réutilisé par l'action publique
// (staff connecté) et par l'action interne des crons (Phase H abonnements).
// La sync préserve les champs locaux des dossiers (local_status/comment…).
async function runHelloAssoSync(
  ctx: ActionCtx,
  linkIds?: Id<"helloasso_links">[],
): Promise<{ synced_count: number; errors: string[] }> {
    const clientId = process.env.HELLOASSO_CLIENT_ID;
    const clientSecret = process.env.HELLOASSO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        synced_count: 0,
        errors: ["HELLOASSO_CLIENT_ID / HELLOASSO_CLIENT_SECRET manquants"],
      };
    }

    const links = await ctx.runQuery(
      internal.helloasso.getLinksInternal,
      linkIds ? { linkIds } : {},
    );
    if (!links || links.length === 0) {
      return { synced_count: 0, errors: ["Aucun lien HelloAsso configuré"] };
    }

    let helloassoToken: string;
    try {
      helloassoToken = await getAccessToken(clientId, clientSecret);
    } catch (e: any) {
      return {
        synced_count: 0,
        errors: [`Erreur d'authentification HelloAsso: ${e.message}`],
      };
    }

    const now = new Date().toISOString();
    const errors: string[] = [];
    const rawPayments: Array<{ payment: any; link: any }> = [];

    for (const link of links) {
      const parsed = parseHaUrl(link.url);
      if (!parsed) {
        errors.push(`URL non parsable [${link.label}]: ${link.url}`);
        continue;
      }
      try {
        const payments = await fetchAllPayments(
          helloassoToken,
          parsed.orgSlug,
          parsed.formType,
          parsed.formSlug
        );
        for (const p of payments) {
          rawPayments.push({ payment: p, link });
        }
      } catch (err: any) {
        errors.push(`[${link.label}] ${err.message}`);
      }
    }

    // Regroupement par commande (order.id), avec repli sur la transaction
    // initiale puis l'id du paiement.
    const groupsMap = new Map<string, Array<{ payment: any; link: any }>>();
    for (const item of rawPayments) {
      const p = item.payment;
      const key = p.order?.id
        ? String(p.order.id)
        : p.initialTransactionId
          ? String(p.initialTransactionId)
          : String(p.id);
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(item);
    }

    function extractPhoneFromGroup(payments: any[]): string | undefined {
      for (const p of payments) {
        const phone = extractPhone(p.items);
        if (phone) return phone;
      }
      return undefined;
    }

    const dossierRows: any[] = [];
    const transactionRows: any[] = [];

    for (const [groupKey, group] of groupsMap.entries()) {
      group.sort((a, b) => a.payment.date.localeCompare(b.payment.date));

      const reference = group[0];
      const refPayment = reference.payment;
      const refLink = reference.link;
      const dossierId = groupKey;

      const payer = refPayment.payer ?? refPayment.order?.payer ?? {};
      const firstItem = refPayment.items?.[0];
      const user = firstItem?.user ?? {};

      const refAmount = refPayment.amount / 100;
      const totalAmount = refLink.is_installment ? refAmount * 3 : refAmount;

      dossierRows.push({
        dossier_id: dossierId,
        helloasso_link_id: refLink._id,
        first_name: user.firstName || payer.firstName || "",
        last_name: user.lastName || payer.lastName || "",
        email: user.email || undefined,
        phone: extractPhoneFromGroup(group.map((g) => g.payment)),
        payer_first_name: payer.firstName || "",
        payer_last_name: payer.lastName || "",
        payer_email: payer.email || "",
        total_amount: totalAmount,
      });

      for (const item of group) {
        const p = item.payment;
        transactionRows.push({
          helloasso_payment_id: String(p.id),
          dossier_id: dossierId,
          amount: p.amount / 100,
          payment_date: p.date,
          helloasso_status: p.state,
          synced_at: now,
          payment_receipt_url: p.paymentReceiptUrl || undefined,
          fiscal_receipt_url: p.fiscalReceiptUrl || undefined,
        });

        if (p.refundOperations && p.refundOperations.length > 0) {
          for (const refund of p.refundOperations) {
            transactionRows.push({
              helloasso_payment_id: `refund-${refund.id}`,
              dossier_id: dossierId,
              amount: -(refund.amount / 100),
              payment_date: refund.meta?.createdAt || p.date,
              helloasso_status: "Refunded",
              synced_at: now,
              payment_receipt_url: undefined,
              fiscal_receipt_url: undefined,
            });
          }
        }
      }
    }

    // Upsert par lots de 100
    const CHUNK = 100;
    let synced_count = 0;

    for (let i = 0; i < dossierRows.length; i += CHUNK) {
      const chunk = dossierRows.slice(i, i + CHUNK);
      try {
        await ctx.runMutation(internal.helloasso.upsertDossiers, {
          dossiers: chunk,
        });
      } catch (e: any) {
        errors.push(`Upsert dossiers: ${e.message}`);
      }
    }

    for (let i = 0; i < transactionRows.length; i += CHUNK) {
      const chunk = transactionRows.slice(i, i + CHUNK);
      try {
        const count = await ctx.runMutation(
          internal.helloasso.upsertTransactions,
          { transactions: chunk }
        );
        synced_count += count;
      } catch (e: any) {
        errors.push(`Upsert transactions: ${e.message}`);
      }
    }

    return { synced_count, errors };
}

// Action publique (staff connecté) — inchangée côté appelants.
export const syncHelloAsso = authenticatedAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "paiements",
    });
    const tentativeAt = new Date().toISOString();
    await ctx.runMutation(internal.abo.syncHealth.marquer, { source: "helloasso_cours", tentativeAt, etat: "en_cours" });
    try {
      const resultat = await runHelloAssoSync(ctx);
      await ctx.runMutation(internal.abo.syncHealth.marquer, {
        source: "helloasso_cours", tentativeAt, etat: resultat.errors.length ? "echec" : "reussie",
      });
      return resultat;
    } catch (error) {
      await ctx.runMutation(internal.abo.syncHealth.marquer, { source: "helloasso_cours", tentativeAt, etat: "echec" });
      throw error;
    }
  },
});

// Version interne (sans garde d'auth) pour les crons Convex (Phase H).
export const syncHelloAssoInternal = internalAction({
  args: {},
  handler: async (ctx) => runHelloAssoSync(ctx),
});

// Synchronisation interne ciblée : les Abonnements ne doivent pas annoncer ni
// importer les paiements des cours dans leur propre suivi.
export const syncHelloAssoLinksInternal = internalAction({
  args: { linkIds: v.array(v.id("helloasso_links")) },
  handler: async (ctx, args) => runHelloAssoSync(ctx, args.linkIds),
});
