import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { normaliserEmail } from "./planningSalaries/lib";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  planningSalariesOtpParEmail: { kind: "fixed window", rate: 3, period: 10 * MINUTE },
  planningSalariesOtpGlobal: { kind: "fixed window", rate: 60, period: MINUTE },
});

async function hashEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function salariePlanningActif(ctx: MutationCtx, emailBrut: string) {
  const email = normaliserEmail(emailBrut);
  const salarie = await ctx.db.query("planning_salaries_annuaire")
    .withIndex("by_emailNormalise", (q) => q.eq("emailNormalise", email)).unique();
  return { email, salarie: salarie?.actif ? salarie : null };
}

export async function consommerDemandePlanningSalariesOtp(ctx: MutationCtx, emailBrut: string) {
  const email = normaliserEmail(emailBrut);
  const [global, individuel] = await Promise.all([
    rateLimiter.limit(ctx, "planningSalariesOtpGlobal", { key: "global" }),
    rateLimiter.limit(ctx, "planningSalariesOtpParEmail", { key: await hashEmail(email) }),
  ]);
  if (!global.ok || !individuel.ok) throw new ConvexError({ code: "PLANNING_OTP_RATE_LIMIT", message: "Veuillez patienter avant de demander un nouveau code." });
  const { salarie } = await salariePlanningActif(ctx, email);
  return { email, autorise: salarie !== null };
}

export const dispatchEmail = internalAction({
  args: { email: v.string(), code: v.string(), shouldSend: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.shouldSend) {
      await ctx.runAction(internal.email.sendPlanningSalariesEmail, {
        to: normaliserEmail(args.email),
        bcc: [],
        subject: `${args.code} : votre code — planning des samedis`,
        text: `Bonjour,\n\nVotre code de connexion est : ${args.code}\n\nIl expire dans 10 minutes.`,
      });
    }
    return null;
  },
});
