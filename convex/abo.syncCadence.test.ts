/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { AUTOMATIC_SYNC_INTERVALS_MS } from "./abo/syncConstants";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.useRealTimers());

test("la consultation des paiements attend quatre heures avant un nouvel import automatique", async () => {
  vi.useFakeTimers();
  const debut = Date.parse("2026-09-05T06:00:00Z");
  vi.setSystemTime(debut);
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "cadence@example.test" });
    await ctx.db.insert("userSettings", {
      userId, allowedTiles: ["paiements"], role: "user",
    });
    await ctx.db.insert("abo_app_config", {
      cle: "last_sync_helloasso", valeur: new Date(debut).toISOString(),
    });
    return userId;
  });

  vi.setSystemTime(debut + 4 * 60 * 60_000 - 1);
  // L'action complète doit s'arrêter au verrou, avant toute requête HelloAsso.
  await expect(t.withIdentity({ subject: userId }).action(
    api.abo.sync.syncPourPaiements, {},
  )).resolves.toEqual({ helloasso: "skipped" });

  vi.setSystemTime(debut + 4 * 60 * 60_000);
  await expect(t.mutation(internal.abo.sync.reserverSync, {
    cle: "last_sync_helloasso", ttlMs: AUTOMATIC_SYNC_INTERVALS_MS.helloasso,
  })).resolves.toMatchObject({ proceed: true });
});
