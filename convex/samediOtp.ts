import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { canoniserEmailUnique } from "./emailValidation";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  samediOtpParEmail: {
    kind: "fixed window",
    rate: 3,
    period: 10 * MINUTE,
  },
  samediOtpGlobal: {
    kind: "fixed window",
    rate: 60,
    period: MINUTE,
  },
});

async function hashEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function participantSamediActif(
  ctx: MutationCtx,
  emailBrut: string,
) {
  const email = canoniserEmailUnique(emailBrut);
  const participant = await ctx.db
    .query("samedis_participants")
    .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email))
    .unique();
  return { email, participant: participant?.actif === true ? participant : null };
}

export async function consommerDemandeSamediOtp(
  ctx: MutationCtx,
  emailBrut: string,
): Promise<{ email: string; autorise: boolean }> {
  const email = canoniserEmailUnique(emailBrut);
  const global = await rateLimiter.limit(ctx, "samediOtpGlobal", { key: "global" });
  const individuel = await rateLimiter.limit(ctx, "samediOtpParEmail", {
    key: await hashEmail(email),
  });
  if (!global.ok || !individuel.ok) {
    throw new ConvexError({
      code: "SAMEDI_OTP_RATE_LIMIT",
      message: "Veuillez patienter avant de demander un nouveau code.",
    });
  }
  const { participant } = await participantSamediActif(ctx, email);
  return { email, autorise: participant !== null };
}

export const consumeRequest = internalMutation({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return (await consommerDemandeSamediOtp(ctx, args.email)).autorise;
  },
});

export const dispatchEmail = internalAction({
  args: {
    email: v.string(),
    code: v.string(),
    shouldSend: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.shouldSend) {
      await ctx.runAction(internal.email.sendSamediEmail, {
        to: canoniserEmailUnique(args.email),
        subject: `${args.code} : votre code de connexion — Samedis après-midi`,
        text: `Bonjour,\n\nVotre code de connexion est : ${args.code}\n\nIl expire dans 10 minutes.\n\nLe club d'escalade CAF La Roche-Bonneville.`,
      });
    }
    return null;
  },
});
