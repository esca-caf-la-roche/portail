import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Amorçage admin : crée (si besoin) les utilisateurs et leur attribue le rôle admin.
// À lancer via la CLI : `npx convex run bootstrap:bootstrapAdmins`
export const bootstrapAdmins = internalMutation({
  args: {
    emails: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const emails = args.emails ?? [
      "escalade@caflarochebonneville.fr",
      "duheronjp@gmail.com",
    ];

    const results: string[] = [];

    for (const email of emails) {
      // Trouver ou créer l'utilisateur.
      let user = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("email"), email))
        .first();

      if (!user) {
        const userId = await ctx.db.insert("users", { email });
        user = await ctx.db.get(userId);
        results.push(`Utilisateur créé : ${email}`);
      }
      if (!user) continue;

      // Upsert des droits : admin.
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", user!._id))
        .first();

      const allowedTiles = ["compta", "paiements", "budget", "taches"];
      if (settings) {
        await ctx.db.patch(settings._id, {
          role: "admin",
          allowedTiles,
          canResetAboSeason: false,
        });
        results.push(`Droits admin mis à jour : ${email}`);
      } else {
        await ctx.db.insert("userSettings", {
          userId: user._id,
          role: "admin",
          allowedTiles,
          canResetAboSeason: false,
        });
        results.push(`Droits admin créés : ${email}`);
      }
    }

    return results;
  },
});
