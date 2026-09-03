/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ANNUAIRE_ATTEMPT_KEY, calculerCreneauAnnuaire } from "./abo/syncConstants";

const modules = import.meta.glob("./**/*.ts");
const heure = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("créneaux annuaire Europe/Paris", () => {
  test.each([
    ["2026-09-03T04:59:59Z", undefined, false, "2026-09-03T05:00:00.000Z"],
    ["2026-09-03T05:00:00Z", undefined, true, null],
    ["2026-09-03T06:59:59Z", "2026-09-03T05:00:00Z", false, "2026-09-03T07:00:00.000Z"],
    ["2026-09-03T07:00:00Z", "2026-09-03T05:00:00Z", true, null],
    ["2026-09-03T16:00:00Z", undefined, true, null],
    ["2026-09-03T16:00:00Z", "2026-09-03T07:00:00Z", false, "2026-09-04T05:00:00.000Z"],
    ["2026-12-03T05:59:59Z", undefined, false, "2026-12-03T06:00:00.000Z"],
    ["2026-12-03T06:00:00Z", undefined, true, null],
    ["2026-12-03T08:00:00Z", "2026-12-03T06:00:00Z", true, null],
    ["2026-03-28T15:00:00Z", "2026-03-28T08:00:00Z", false, "2026-03-29T05:00:00.000Z"],
    ["2026-10-24T15:00:00Z", "2026-10-24T07:00:00Z", false, "2026-10-25T06:00:00.000Z"],
    ["2026-12-31T15:00:00Z", "2026-12-31T08:00:00Z", false, "2027-01-01T06:00:00.000Z"],
  ])("%s respecte le calendrier civil", (now, tentative, disponible, nextSyncAt) => {
    expect(calculerCreneauAnnuaire(Date.parse(now), tentative)).toEqual({ disponible, nextSyncAt });
  });

  test("la migration libère 7 h après 5 h 30, sans rejouer un ancien créneau de 7 h", () => {
    const now = Date.parse("2026-09-03T06:00:00Z");
    expect(calculerCreneauAnnuaire(now, undefined, "2026-09-03T03:30:00Z").disponible).toBe(true);
    expect(calculerCreneauAnnuaire(now, undefined, "2026-09-03T05:15:00Z").disponible).toBe(false);
    // Une réussite après 9 h d'un import commencé avant 9 h ne consomme pas le second créneau.
    expect(calculerCreneauAnnuaire(Date.parse("2026-09-03T07:02:00Z"),
      "2026-09-03T06:59:00Z", "2026-09-03T07:01:00Z").disponible).toBe(true);
  });
});

async function valeur(t: TestConvex<typeof schema>, cle: string) {
  return await t.run(async (ctx) => (await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", cle)).unique())?.valeur ?? null);
}

describe("import annuaire à la demande", () => {
  test("réserve atomiquement au plus un appel par créneau pour tous les visiteurs", async () => {
    vi.useFakeTimers();
    heure("2026-09-03T05:00:00Z");
    const t = convexTest(schema, modules);
    const reservations = await Promise.all(Array.from({ length: 4 }, () =>
      t.mutation(internal.abo.sync.reserverSyncAnnuaire, {})));
    expect(reservations.filter((r) => r.statut === "reserved")).toHaveLength(1);
    expect(reservations.filter((r) => r.statut === "skipped")).toHaveLength(3);
    expect(await valeur(t, "last_sync_annuaire")).toBeNull();
    heure("2026-09-03T07:00:00Z");
    expect((await t.mutation(internal.abo.sync.reserverSyncAnnuaire, {})).statut).toBe("reserved");
    heure("2026-09-03T21:30:00Z");
    expect((await t.mutation(internal.abo.sync.reserverSyncAnnuaire, {})).statut).toBe("skipped");
    heure("2026-09-04T05:00:00Z");
    expect((await t.mutation(internal.abo.sync.reserverSyncAnnuaire, {})).statut).toBe("reserved");
  });

  test("avant 7 h, en pause ou avec une génération périmée : ni fetch ni consommation", async () => {
    vi.useFakeTimers();
    heure("2026-09-03T04:59:00Z");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    expect((await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {})).statut).toBe("skipped");
    heure("2026-09-03T05:00:00Z");
    expect((await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, { generation: 99 })).statut).toBe("desactive");
    await t.run(async (ctx) => { await ctx.db.insert("abo_app_config", {
      cle: "synchronisation_externe_active", valeur: "false",
    }); });
    expect((await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {})).statut).toBe("desactive");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await valeur(t, ANNUAIRE_ATTEMPT_KEY)).toBeNull();
  });

  test("partage le budget manuel/automatique et conserve un créneau en échec", async () => {
    vi.useFakeTimers();
    heure("2026-09-03T05:00:00Z");
    vi.stubEnv("LICENCES_USER", "test");
    vi.stubEnv("LICENCES_PASSWORD", "test");
    const fetchMock = vi.fn().mockResolvedValue(new Response("indisponible", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "sync@example.test" });
      await ctx.db.insert("userSettings", { userId: id, role: "user", allowedTiles: ["abonnements"] });
      return id;
    });
    const admin = t.withIdentity({ subject: userId });
    await expect(admin.action(api.abo.licences.importerAnnuaireLicences, {})).rejects.toThrow("HTTP 503");
    expect(await valeur(t, "last_sync_annuaire")).toBeNull();
    expect((await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {})).statut).toBe("skipped");
    expect((await admin.action(api.abo.licences.importerAnnuaireLicences, {})).statut).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    heure("2026-09-03T07:00:00Z");
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { numero_licence: "123456789012", nom: "DUPONT", prenom: "ALICE" },
    ]), { status: 200 }));
    expect(await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {})).toMatchObject({
      statut: "done", upsertees: 1, recus: 1, supprimees: 0,
    });
    expect(await valeur(t, "last_sync_annuaire")).toBe("2026-09-03T07:00:00.000Z");
    expect((await admin.action(api.abo.licences.importerAnnuaireLicences, {})).retryAt).toBe("2026-09-04T05:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Le seul passage du temps, sans visite, ne déclenche aucun travail.
    heure("2026-09-05T18:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("un administrateur sans la tuile ne peut pas déclencher l'import", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "sans-tuile@example.test" });
      await ctx.db.insert("userSettings", { userId: id, role: "admin", allowedTiles: [] });
      return id;
    });
    await expect(t.withIdentity({ subject: userId }).action(api.abo.licences.importerAnnuaireLicences, {}))
      .rejects.toThrow("Réservé aux administrateurs");
    expect(await valeur(t, ANNUAIRE_ATTEMPT_KEY)).toBeNull();
  });

  test("un téléchargement de 8 h 59 ne peut écraser le snapshot de 9 h", async () => {
    vi.useFakeTimers();
    heure("2026-09-03T06:59:59Z");
    vi.stubEnv("LICENCES_USER", "test");
    vi.stubEnv("LICENCES_PASSWORD", "test");
    let signalDepart!: () => void;
    const depart = new Promise<void>((resolve) => { signalDepart = resolve; });
    let terminerAncien!: (response: Response) => void;
    const reponseAncienne = new Promise<Response>((resolve) => { terminerAncien = resolve; });
    const snapshot = (licence: string) => new Response(JSON.stringify([
      { numero_licence: licence, nom: "DUPONT", prenom: "ALICE" },
    ]));
    const fetchMock = vi.fn().mockImplementationOnce(() => {
      signalDepart();
      return reponseAncienne;
    }).mockResolvedValueOnce(snapshot("987654321098"));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const ancienImport = t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {});
    await depart;
    const ancienToken = await valeur(t, ANNUAIRE_ATTEMPT_KEY);
    heure("2026-09-03T07:00:00Z");
    expect((await t.action(internal.abo.licences.importerAnnuaireLicencesInternal, {})).statut).toBe("done");
    terminerAncien(snapshot("123456789012"));
    await expect(ancienImport).rejects.toThrow("créneau plus récent");
    await expect(t.mutation(internal.abo.licences.supprimerLicencesAbsentes, {
      licences: ["123456789012"], tentativeAt: ancienToken!,
    })).rejects.toThrow("créneau plus récent");
    await expect(t.mutation(internal.abo.sync.marquerSyncReussie, {
      source: "annuaire", reussieAt: "2026-09-03T07:01:00Z", annuaireTentativeAt: ancienToken!,
    })).rejects.toThrow("créneau plus récent");
    expect(await t.run(async (ctx) => (await ctx.db.query("abo_licences").take(3))
      .map((licence) => licence.licence))).toEqual(["987654321098"]);
    expect(await valeur(t, "last_sync_annuaire")).toBe("2026-09-03T07:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
