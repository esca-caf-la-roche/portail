/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  lireVacances,
  samediBloqueParPeriodeScolaire,
  samedisBloquesParVacances,
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
      lieuParDefaut: "Filière Grimpe",
      academie: "Grenoble",
      zone: "A",
      statutSynchronisation,
      updatedAt: 1,
      updatedBy: managerId,
    });
    const creneau1 = await ctx.db.insert("samedis_creneaux", {
      saison: "2026-27",
      date: "2026-09-05",
      lieu: "Filière Grimpe",
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
      updatedAt: 1,
      updatedBy: managerId,
    });
    const creneau2 = await ctx.db.insert("samedis_creneaux", {
      saison: "2026-27",
      date: "2026-09-12",
      lieu: "CT74",
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
      updatedAt: 1,
      updatedBy: managerId,
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
  test("bloque seulement les samedis strictement compris dans les vacances", () => {
    const periodes = [
      {
        start_date: "2025-10-18",
        end_date: "2025-11-03",
        description: "Vacances de la Toussaint",
      },
      {
        start_date: "2026-02-07",
        end_date: "2026-02-23",
        description: "Vacances d'hiver",
      },
    ];

    expect(samedisBloquesParVacances(
      [
        "2025-10-18",
        "2025-10-25",
        "2025-11-01",
        "2025-11-08",
        "2026-02-07",
        "2026-02-14",
        "2026-02-21",
        "2026-02-28",
      ],
      periodes,
    )).toEqual([
      "2025-10-25",
      "2025-11-01",
      "2026-02-14",
      "2026-02-21",
    ]);

  });

  test("conserve les fermetures officielles d'une seule journée", () => {
    expect(lireVacances({
      results: [{
        start_date: "2027-05-07T00:00:00+02:00",
        end_date: "2027-05-07T00:00:00+02:00",
        description: "Pont de l'Ascension",
      }],
    })).toEqual([{
      start_date: "2027-05-07",
      end_date: "2027-05-07",
      description: "Pont de l'Ascension",
    }]);
  });

  test("traite le vendredi ponctuel du pont sans bloquer un samedi ponctuel", () => {
    expect(samedisBloquesParVacances(
      ["2027-05-01", "2027-05-08", "2027-05-15", "2027-07-03"],
      [
        {
          start_date: "2027-05-07",
          end_date: "2027-05-07",
          description: "Pont de l'Ascension",
        },
        {
          start_date: "2027-07-03",
          end_date: "2027-07-03",
          description: "Début des vacances d'été",
        },
      ],
    )).toEqual(["2027-05-08"]);

    expect(samediBloqueParPeriodeScolaire(
      "2027-07-03",
      "2027-07-03",
      "2027-07-03",
    )).toBe(false);
  });

  test("bloque le samedi du pont quand l'API fournit une période ordinaire", () => {
    expect(samedisBloquesParVacances(
      ["2026-05-09", "2026-05-16", "2026-05-23"],
      [{
        start_date: "2026-05-14",
        end_date: "2026-05-18",
        description: "Pont de l'Ascension",
      }],
    )).toEqual(["2026-05-16"]);
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
