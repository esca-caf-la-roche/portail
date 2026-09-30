/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("le résumé n'expose que les sources des tuiles attribuées et conserve le dernier état", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "synchealth@example.test" });
    await ctx.db.insert("userSettings", { userId: id, role: "user", allowedTiles: ["paiements"] });
    return id;
  });
  await t.mutation(internal.abo.syncHealth.marquer, { source: "helloasso", tentativeAt: "2026-09-30T09:00:00.000Z", etat: "en_cours" });
  await t.mutation(internal.abo.syncHealth.marquer, { source: "helloasso", tentativeAt: "2026-09-30T09:00:00.000Z", etat: "echec" });
  await t.mutation(internal.abo.syncHealth.marquer, { source: "helloasso", tentativeAt: "2026-09-30T09:00:00.000Z", etat: "en_cours" });
  await t.mutation(internal.abo.syncHealth.marquer, { source: "eleves", tentativeAt: "2026-09-30T09:00:00.000Z", etat: "echec" });
  expect(await t.withIdentity({ subject: userId }).query(api.abo.syncHealth.resume, {})).toEqual([
    { source: "helloasso", tentativeAt: "2026-09-30T09:00:00.000Z", etat: "echec", lien: "/paiements/validation" },
  ]);
  await t.mutation(internal.abo.syncHealth.marquer, { source: "helloasso", tentativeAt: "2026-09-30T08:00:00.000Z", etat: "reussie" });
  expect((await t.withIdentity({ subject: userId }).query(api.abo.syncHealth.resume, {}))[0].etat).toBe("echec");
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("userSettings").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
    if (settings) await ctx.db.patch(settings._id, { allowedTiles: [] });
  });
  expect(await t.withIdentity({ subject: userId }).query(api.abo.syncHealth.resume, {})).toEqual([]);
});
