/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("état des synchronisations Abonnements", () => {
  test("expose les quatre sources, leurs délais et l'activation externe", async () => {
    const t = convexTest(schema, modules);
    const derniereSync = "2026-09-01T08:00:00.000Z";
    const derniereSyncManuelleHelloasso = "2026-09-01T08:02:00.000Z";
    const maintenantMs = Date.parse(derniereSync);
    const { staffId, sansTuileId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("users", { email: "abo-sync@example.test" });
      await ctx.db.insert("userSettings", {
        userId: staffId,
        allowedTiles: ["abonnements"],
        role: "user",
      });
      const sansTuileId = await ctx.db.insert("users", {
        email: "sans-abo-sync@example.test",
      });
      await ctx.db.insert("userSettings", {
        userId: sansTuileId,
        allowedTiles: [],
        role: "admin",
      });
      await Promise.all([
        ctx.db.insert("abo_app_config", {
          cle: "last_sync_helloasso",
          valeur: derniereSync,
        }),
        ctx.db.insert("abo_app_config", {
          cle: "last_sync_scrap",
          valeur: derniereSync,
        }),
        ctx.db.insert("abo_app_config", {
          cle: "last_sync_annuaire",
          valeur: derniereSync,
        }),
        ctx.db.insert("abo_app_config", {
          cle: "last_manual_sync_paiements_abo",
          valeur: derniereSyncManuelleHelloasso,
        }),
        ctx.db.insert("abo_app_config", {
          cle: "synchronisation_externe_active",
          valeur: "false",
        }),
      ]);
      return { staffId, sansTuileId };
    });

    const statut = await t.withIdentity({ subject: staffId }).query(
      api.abo.sync.getStatutSyncAbo,
      { maintenantMs },
    );

    expect(statut.helloasso).toMatchObject({
      active: true,
      lastSyncAt: derniereSync,
      manualIntervalMs: 5 * 60_000,
      manualNextSyncAt: "2026-09-01T08:07:00.000Z",
    });
    expect(statut.scrap).toMatchObject({
      active: false,
      manualIntervalMs: 5 * 60_000,
      manualNextSyncAt: "2026-09-01T08:05:00.000Z",
    });
    expect(statut.annuaire).toMatchObject({
      active: false,
      lastSyncAt: derniereSync,
      minimumIntervalMs: 0,
      nextSyncAt: "2026-09-02T05:00:00.000Z",
      manualIntervalMs: 0,
      manualNextSyncAt: "2026-09-02T05:00:00.000Z",
    });
    expect(statut.eleves).toMatchObject({
      active: false,
      lastSyncAt: null,
      nextSyncAt: null,
      manualIntervalMs: 5 * 60_000,
      manualNextSyncAt: "2026-09-01T08:05:00.000Z",
    });
    expect(statut.helloasso.nextSyncAt).toBe(
      new Date(maintenantMs + statut.helloasso.minimumIntervalMs).toISOString(),
    );

    const resultatSync = await t.withIdentity({ subject: staffId }).action(
      api.abo.sync.syncPourAbo,
      {},
    );
    expect(resultatSync.eleves).toBe("desactive");
    expect(await t.run(async (ctx) => await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", "last_sync_eleves"))
      .unique())).toBeNull();

    const reussieAt = "2026-09-01T08:03:00.000Z";
    await t.mutation(internal.abo.sync.marquerSyncReussie, {
      source: "eleves",
      reussieAt,
    });
    await t.mutation(internal.abo.sync.marquerSyncReussie, {
      source: "eleves",
      reussieAt,
    });
    expect(await t.run(async (ctx) => await ctx.db
      .query("abo_app_config")
      .withIndex("by_cle", (q) => q.eq("cle", "last_sync_eleves"))
      .unique())).toMatchObject({ valeur: reussieAt, updated_at: reussieAt });

    await expect(t.withIdentity({ subject: sansTuileId }).query(
      api.abo.sync.getStatutSyncAbo,
      { maintenantMs },
    )).rejects.toThrow("Accès refusé");
  });

  test("conserve l'appel historique sans argument du statut licences/cours", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "licences-sync@example.test" });
      await ctx.db.insert("userSettings", {
        userId: id,
        allowedTiles: ["licences_cours"],
        role: "user",
      });
      return id;
    });

    await expect(t.withIdentity({ subject: userId }).query(
      api.abo.sync.getStatutSyncLicencesCours,
      {},
    )).resolves.toEqual({
      eleves: { lastSyncAt: null, nextSyncAt: null },
      annuaire: { lastSyncAt: null, nextSyncAt: null },
    });
  });
});
