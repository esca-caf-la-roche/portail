/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  samediBloqueParPeriodeScolaire,
  semaineDuSamediEnVacances,
} from "./samedis/sync";

const modules = import.meta.glob("./**/*.ts");

async function fixture(statutSynchronisation?: "ok" | "erreur") {
  const t = convexTest(schema, modules);
  const donnees = await t.run(async (ctx) => {
    const managerId = await ctx.db.insert("users", { email: "manager-samedis@example.test" });
    await ctx.db.insert("userSettings", {
      userId: managerId,
      allowedTiles: ["samedis"],
      role: "user",
    });
    const participantUserId = await ctx.db.insert("users", { email: "alice@example.test" });
    const participantId = await ctx.db.insert("samedis_participants", {
      nom: "Alice",
      email: "alice@example.test",
      emailNormalise: "alice@example.test",
      userId: participantUserId,
      actif: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const autreUserId = await ctx.db.insert("users", { email: "bob@example.test" });
    const autreParticipantId = await ctx.db.insert("samedis_participants", {
      nom: "Bob",
      email: "bob@example.test",
      emailNormalise: "bob@example.test",
      userId: autreUserId,
      actif: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("samedis_configurations", {
      saison: "2026-27",
      dateDebut: "2026-09-01",
      dateFin: "2027-06-30",
      statutSynchronisation,
    });
    const creneau1 = await ctx.db.insert("samedis_creneaux", {
      saison: "2026-27",
      date: "2026-09-05",
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
    });
    const creneau2 = await ctx.db.insert("samedis_creneaux", {
      saison: "2026-27",
      date: "2026-09-12",
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
    });
    return {
      managerId,
      participantUserId,
      participantId,
      autreUserId,
      autreParticipantId,
      creneau1,
      creneau2,
    };
  });
  return { t, ...donnees };
}

describe("réservations des samedis", () => {
  test("refuse toute attribution avant synchronisation, y compris gestionnaire", async () => {
    const f = await fixture();
    await expect(f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau1 },
    )).rejects.toThrow("après la synchronisation");
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.reservations.reserverCommeGestionnaire,
      {
        saison: "2026-27",
        creneauId: f.creneau1,
        participantId: f.participantId,
        forcer: false,
      },
    )).rejects.toThrow("après la synchronisation");
  });

  test("garantit une seule réservation et masque les identifiants des tiers", async () => {
    const f = await fixture("ok");
    const bob = f.t.withIdentity({ subject: f.autreUserId });
    await bob.mutation(api.samedis.reservations.reserver, {
      saison: "2026-27",
      creneauId: f.creneau1,
    });
    await expect(f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau1 },
    )).rejects.toThrow("déjà réservé");
    const calendrier = await f.t.withIdentity({ subject: f.participantUserId }).query(
      api.samedis.calendrier.forParticipant,
      { saison: "2026-27" },
    );
    expect(calendrier.creneaux[0]?.reservation).toEqual({
      occupee: true,
      estLaMienne: false,
    });
  });

  test("signale puis régularise une réservation devenue bloquée sans falsifier son auteur", async () => {
    const f = await fixture("ok");
    const reservationId = await f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau1 },
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.creneau1, {
        estBloque: true,
        motifsBlocage: ["Vacances scolaires"],
        sourcesBlocage: ["vacances"],
      });
    });
    const manager = f.t.withIdentity({ subject: f.managerId });
    const avant = await manager.query(api.samedis.calendrier.forManager, { saison: "2026-27" });
    expect(avant.creneaux[0]?.reservation?.aRegulariser).toBe(true);
    await manager.mutation(api.samedis.reservations.regulariserReservation, { reservationId });
    const reservation = await f.t.run((ctx) => ctx.db.get(reservationId));
    expect(reservation).toMatchObject({
      forcee: true,
      createdBy: f.participantUserId,
      mode: "participant",
    });
  });

  test("refuse un blocage manuel tant qu'une réservation normale existe", async () => {
    const f = await fixture("ok");
    await f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau2 },
    );
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      {
        creneauId: f.creneau2,
        bloqueManuellement: true,
        motif: "Fermeture exceptionnelle",
      },
    )).rejects.toThrow("Annulez la réservation ou régularisez-la");
  });
});

describe("vacances scolaires des samedis", () => {
  test("se base sur la semaine scolaire et non sur le début civil du samedi", () => {
    const debut = "2026-10-17";
    const fin = "2026-11-02";

    expect(semaineDuSamediEnVacances("2026-10-17", debut, fin)).toBe(false);
    expect(semaineDuSamediEnVacances("2026-10-24", debut, fin)).toBe(true);
    expect(semaineDuSamediEnVacances("2026-10-31", debut, fin)).toBe(true);
  });

  test("bloque le samedi du pont de l'Ascension même si son lundi est travaillé", () => {
    expect(samediBloqueParPeriodeScolaire(
      "2027-05-08",
      "2027-05-05",
      "2027-05-10",
      "Pont de l'Ascension",
    )).toBe(true);
  });
});

describe("rafraîchissement du calendrier officiel", () => {
  test("autorise une relance manuelle récente tout en gardant un verrou court", async () => {
    const f = await fixture("ok");
    const maintenant = 1_800_000_000_000;

    const premiere = await f.t.mutation(internal.samedis.sync.reserverSync, {
      saison: "2026-27",
      acteurUserId: f.managerId,
      maintenant,
      actualiserMemeSiRecent: false,
    });
    expect(premiere.lancee).toBe(true);

    const concurrente = await f.t.mutation(internal.samedis.sync.reserverSync, {
      saison: "2026-27",
      acteurUserId: f.managerId,
      maintenant: maintenant + 1_000,
      actualiserMemeSiRecent: true,
    });
    expect(concurrente.lancee).toBe(false);

    const relanceManuelle = await f.t.mutation(internal.samedis.sync.reserverSync, {
      saison: "2026-27",
      acteurUserId: f.managerId,
      maintenant: maintenant + 31_000,
      actualiserMemeSiRecent: true,
    });
    expect(relanceManuelle.lancee).toBe(true);
  });
});
