/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { migrerAffectationPlanningVersSamedi } from "./migrations";
import { bornesSaison, PLACEHOLDER_RESOURCE } from "./planningSalaries/lib";

const modules = import.meta.glob("./**/*.ts");

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const managerId = await ctx.db.insert("users", { email: "manager@example.test" });
    await ctx.db.insert("userSettings", {
      userId: managerId,
      allowedTiles: ["planning_salaries_samedis", "samedis"],
      role: "admin",
    });
    const aliceUserId = await ctx.db.insert("users", { email: "alice@example.test" });
    const aliceId = await ctx.db.insert("planning_salaries_annuaire", {
      prenom: "Alice",
      email: "alice@example.test",
      emailNormalise: "alice@example.test",
      resourceCalendarId: "alice@resource.calendar.google.com",
      resourceCalendarIdNormalise: "alice@resource.calendar.google.com",
      userId: aliceUserId,
      actif: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const creneauId = await ctx.db.insert("planning_salaries_creneaux", {
      saison: "2026-27",
      date: "2026-09-05",
      debut: "2026-09-05T12:00:00+02:00",
      fin: "2026-09-05T14:00:00+02:00",
      groupe: "Groupe 1",
      titre: "Groupe 1",
      googleCalendarId: "calendar@example.test",
      googleEventId: "event-1",
      googleOccurrenceStart: "2026-09-05T12:00:00+02:00",
      currentResourceCalendarId: PLACEHOLDER_RESOURCE,
      syncedAt: 1,
      updatedAt: 1,
    });
    const secondCreneauId = await ctx.db.insert("planning_salaries_creneaux", {
      saison: "2026-27",
      date: "2026-09-05",
      debut: "2026-09-05T14:00:00+02:00",
      fin: "2026-09-05T16:00:00+02:00",
      groupe: "Groupe 2",
      titre: "Groupe 2",
      googleCalendarId: PLACEHOLDER_RESOURCE,
      googleEventId: "event-2",
      googleOccurrenceStart: "2026-09-05T14:00:00+02:00",
      currentResourceCalendarId: PLACEHOLDER_RESOURCE,
      syncedAt: 1,
      updatedAt: 1,
    });
    return { managerId, aliceUserId, aliceId, creneauId, secondCreneauId };
  });
  return { t, ...ids };
}

describe("planning des salariés du samedi", () => {
  test("dérive les bornes septembre-août", () => {
    expect(bornesSaison("2026-27")).toMatchObject({
      dateDebut: "2026-09-01",
      dateFin: "2027-08-31",
    });
  });

  test("isole le salarié tout en lui montrant le planning et les compteurs", async () => {
    const f = await fixture();
    const alice = f.t.withIdentity({ subject: f.aliceUserId });
    const calendrier = await alice.query(api.planningSalaries.calendrier.list, { saison: "2026-27" });
    expect(calendrier.gestionnaire).toBe(false);
    expect(calendrier.creneaux[0]?.salarie).toBeNull();
    expect(calendrier.compteurs[0]).toMatchObject({ prenom: "À déterminer", samedis: 1 });
    expect(await alice.query(api.planningSalaries.identity.me, {})).toEqual({
      gestionnaire: false,
      salarie: { _id: f.aliceId, prenom: "Alice" },
    });
  });

  test("retourne un état d'aiguillage neutre pour une autre population authentifiée", async () => {
    const f = await fixture();
    const autreUserId = await f.t.run((ctx) =>
      ctx.db.insert("users", { email: "abonne@example.test" }),
    );
    await expect(
      f.t.withIdentity({ subject: autreUserId }).query(
        api.planningSalaries.identity.me,
        {},
      ),
    ).resolves.toEqual({ gestionnaire: false, salarie: null });
  });

  test("refuse d'ajouter à l'annuaire une adresse déjà liée au staff", async () => {
    const f = await fixture();
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.planningSalaries.annuaire.ajouter,
      {
        prenom: "Manager",
        email: "manager@example.test",
        resourceCalendarId: "manager@resource.calendar.google.com",
      },
    )).rejects.toThrow("portail staff");
  });

  test("refuse de transformer une fiche salariée en compte staff", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("planning_salaries_annuaire", {
      prenom: "Chloé",
      email: "chloe@example.test",
      emailNormalise: "chloe@example.test",
      resourceCalendarId: "chloe@resource.calendar.google.com",
      resourceCalendarIdNormalise: "chloe@resource.calendar.google.com",
      actif: true,
      createdAt: 1,
      updatedAt: 1,
    }));
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.users.addUser,
      { email: "chloe@example.test", name: "Chloé" },
    )).rejects.toThrow("planning salarié isolé");
  });

  test("refuse les collisions avec les autres espaces publics isolés", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const aboUserId = await ctx.db.insert("users", { email: "abo@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: aboUserId,
        email: "abo@example.test",
        role: "utilisateur",
      });
      await ctx.db.insert("samedis_participants", {
        nom: "Sam",
        email: "sam@example.test",
        emailNormalise: "sam@example.test",
        actif: true,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const manager = f.t.withIdentity({ subject: f.managerId });
    for (const email of ["abo@example.test", "sam@example.test"]) {
      await expect(manager.mutation(api.planningSalaries.annuaire.ajouter, {
        prenom: "Collision",
        email,
        resourceCalendarId: `${email.split("@")[0]}@resource.calendar.google.com`,
      })).rejects.toThrow("autre espace isolé");
    }
    await expect(manager.mutation(api.samedis.admin.addParticipant, {
      nom: "Alice",
      email: "alice@example.test",
    })).rejects.toThrow("planning salarié isolé");
  });

  test("affecte tout le samedi et crée une opération par événement", async () => {
    const f = await fixture();
    await f.t.withIdentity({ subject: f.aliceUserId }).mutation(
      api.planningSalaries.affectations.affecter,
      { saison: "2026-27", date: "2026-09-05" },
    );
    const resultat = await f.t.run(async (ctx) => ({
      affectations: await ctx.db.query("planning_salaries_affectations").collect(),
      operations: await ctx.db.query("planning_salaries_google_operations").collect(),
    }));
    expect(resultat.affectations).toHaveLength(1);
    expect(resultat.affectations[0]?.salarieId).toBe(f.aliceId);
    expect(resultat.affectations[0]?.date).toBe("2026-09-05");
    expect(resultat.operations).toHaveLength(2);
    for (const operation of resultat.operations) {
      expect(operation).toMatchObject({
        date: "2026-09-05",
        sourceResourceCalendarId: PLACEHOLDER_RESOURCE,
        targetResourceCalendarId: "alice@resource.calendar.google.com",
        tentatives: 0,
      });
    }
  });

  test("retire tout le samedi et replace chaque événement à déterminer", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.creneauId, {
        googleCalendarId: "alice@resource.calendar.google.com",
        currentResourceCalendarId: "alice@resource.calendar.google.com",
      });
      await ctx.db.patch(f.secondCreneauId, {
        googleCalendarId: "alice@resource.calendar.google.com",
        currentResourceCalendarId: "alice@resource.calendar.google.com",
      });
      await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        date: "2026-09-05",
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 1,
        updatedBy: f.managerId,
        updatedAt: 1,
      });
    });
    await f.t.withIdentity({ subject: f.aliceUserId }).mutation(
      api.planningSalaries.affectations.retirer,
      { saison: "2026-27", date: "2026-09-05" },
    );
    const resultat = await f.t.run(async (ctx) => ({
      affectations: await ctx.db.query("planning_salaries_affectations").collect(),
      operations: await ctx.db.query("planning_salaries_google_operations").collect(),
    }));
    expect(resultat.affectations).toHaveLength(0);
    expect(resultat.operations).toHaveLength(2);
    expect(resultat.operations.every(
      (operation) => operation.targetResourceCalendarId === PLACEHOLDER_RESOURCE,
    )).toBe(true);
  });

  test("migre et fusionne les anciennes affectations du même salarié", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const premier = await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        creneauId: f.creneauId,
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 1,
        updatedBy: f.managerId,
        updatedAt: 1,
      });
      const second = await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        creneauId: f.secondCreneauId,
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 2,
        updatedBy: f.managerId,
        updatedAt: 2,
      });
      const operation = await ctx.db.insert("planning_salaries_google_operations", {
        saison: "2026-27",
        creneauId: f.secondCreneauId,
        affectationId: second,
        type: "remplacer_ressource",
        idempotencyKey: "legacy-operation",
        sourceResourceCalendarId: PLACEHOLDER_RESOURCE,
        targetResourceCalendarId: "alice@resource.calendar.google.com",
        statut: "traitee",
        tentatives: 1,
        createdAt: 2,
        updatedAt: 2,
      });
      return { premier, operation };
    });
    await f.t.run(async (ctx) => {
      const initiale = await ctx.db.get(ids.premier);
      if (!initiale) throw new Error("Fixture absente");
      await migrerAffectationPlanningVersSamedi(ctx, initiale);
    });
    const resultat = await f.t.run(async (ctx) => ({
      affectations: await ctx.db.query("planning_salaries_affectations").collect(),
      operation: await ctx.db.get(ids.operation),
    }));
    expect(resultat.affectations).toHaveLength(1);
    expect(resultat.affectations[0]).toMatchObject({
      date: "2026-09-05",
      salarieId: f.aliceId,
    });
    expect(resultat.affectations[0]?.creneauId).toBeUndefined();
    expect(resultat.operation).toMatchObject({
      date: "2026-09-05",
      affectationId: resultat.affectations[0]?._id,
    });
  });

  test("bloque la migration si deux salariés différents couvrent le même samedi", async () => {
    const f = await fixture();
    const premier = await f.t.run(async (ctx) => {
      const bob = await ctx.db.insert("planning_salaries_annuaire", {
        prenom: "Bob",
        email: "bob-migration@example.test",
        emailNormalise: "bob-migration@example.test",
        resourceCalendarId: "bob-migration@resource.calendar.google.com",
        resourceCalendarIdNormalise: "bob-migration@resource.calendar.google.com",
        actif: true,
        createdAt: 1,
        updatedAt: 1,
      });
      const id = await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        creneauId: f.creneauId,
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 1,
        updatedBy: f.managerId,
        updatedAt: 1,
      });
      await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        creneauId: f.secondCreneauId,
        salarieId: bob,
        resourceCalendarIdSnapshot: "bob-migration@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 2,
        updatedBy: f.managerId,
        updatedAt: 2,
      });
      return id;
    });
    await expect(f.t.run(async (ctx) => {
      const initiale = await ctx.db.get(premier);
      if (!initiale) throw new Error("Fixture absente");
      await migrerAffectationPlanningVersSamedi(ctx, initiale);
    })).rejects.toThrow("CONFLIT_PLANNING_SALARIES");
  });

  test("interdit à un salarié de remplacer directement un collègue", async () => {
    const f = await fixture();
    const bobUserId = await f.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "bob@example.test" });
      await ctx.db.insert("planning_salaries_annuaire", {
        prenom: "Bob",
        email: "bob@example.test",
        emailNormalise: "bob@example.test",
        resourceCalendarId: "bob@resource.calendar.google.com",
        resourceCalendarIdNormalise: "bob@resource.calendar.google.com",
        userId,
        actif: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        date: "2026-09-05",
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 1,
        updatedBy: f.managerId,
        updatedAt: 1,
      });
      return userId;
    });
    await expect(f.t.withIdentity({ subject: bobUserId }).mutation(
      api.planningSalaries.affectations.affecter,
      { saison: "2026-27", date: "2026-09-05" },
    )).rejects.toThrow("déjà attribué à un autre salarié");
    const affectation = await f.t.run((ctx) => ctx.db.query("planning_salaries_affectations").first());
    expect(affectation?.salarieId).toBe(f.aliceId);
  });

  test("planifie une alerte unique par samedi non affecté", async () => {
    const f = await fixture();
    await f.t.mutation(internal.planningSalaries.alertes.reconcilierDate, {
      saison: "2026-27",
      date: "2026-09-05",
      maintenant: Date.parse("2026-08-25T07:00:00Z"),
    });
    await f.t.mutation(internal.planningSalaries.alertes.reconcilierDate, {
      saison: "2026-27",
      date: "2026-09-05",
      maintenant: Date.parse("2026-08-25T07:00:00Z") + 1,
    });
    const alertes = await f.t.run((ctx) => ctx.db.query("planning_salaries_alertes").collect());
    expect(alertes).toHaveLength(1);
    expect(alertes[0]?.statut).toBe("planifiee");
  });

  test("n'envoie pas d'alerte historique pour un samedi passé", async () => {
    const f = await fixture();
    await f.t.mutation(internal.planningSalaries.alertes.reconcilierDate, {
      saison: "2026-27",
      date: "2026-09-05",
      maintenant: Date.parse("2026-09-06T22:00:00Z"),
    });
    expect(await f.t.run((ctx) => ctx.db.query("planning_salaries_alertes").collect()))
      .toHaveLength(0);
  });

  test("bloque le changement de ressource tant qu'une affectation à venir existe", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("planning_salaries_affectations", {
      saison: "2026-27",
      date: "2026-09-05",
      salarieId: f.aliceId,
      resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
      createdBy: f.managerId,
      createdAt: 1,
      updatedBy: f.managerId,
      updatedAt: 1,
    }));
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.planningSalaries.annuaire.modifier,
      {
        salarieId: f.aliceId,
        prenom: "Alice",
        email: "alice@example.test",
        resourceCalendarId: "alice-new@resource.calendar.google.com",
        actif: true,
      },
    )).rejects.toThrow("affectation à venir");
  });

  test("purge du cache une occurrence retirée de Google", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("planning_salaries_sync", {
      saison: "2026-27",
      cle: "google_calendar",
      statut: "en_cours",
      verrouJusqua: 1_000,
      updatedAt: 100,
    }));
    await f.t.mutation(internal.planningSalaries.syncDb.appliquerSync, {
      saison: "2026-27",
      startedAt: 100,
      acteurUserId: f.managerId,
      evenements: [],
    });
    expect(await f.t.run((ctx) => ctx.db.query("planning_salaries_creneaux").collect()))
      .toHaveLength(0);
  });

  test("ne réaffecte pas un samedi futur à un salarié inactif", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.aliceId, { actif: false });
      await ctx.db.insert("planning_salaries_sync", {
        saison: "2026-27",
        cle: "google_calendar",
        statut: "en_cours",
        verrouJusqua: Date.parse("2026-09-01T00:00:00Z"),
        updatedAt: Date.parse("2026-08-25T00:00:00Z"),
      });
    });
    await f.t.mutation(internal.planningSalaries.syncDb.appliquerSync, {
      saison: "2026-27",
      startedAt: Date.parse("2026-08-25T00:00:00Z"),
      acteurUserId: f.managerId,
      evenements: [{
        date: "2026-09-05",
        debut: "2026-09-05T12:00:00+02:00",
        fin: "2026-09-05T14:00:00+02:00",
        groupe: "Groupe 1",
        titre: "Groupe 1",
        googleCalendarId: "alice@resource.calendar.google.com",
        googleEventId: "event-1",
        googleOccurrenceStart: "2026-09-05T12:00:00+02:00",
        currentResourceCalendarId: "alice@resource.calendar.google.com",
      }],
    });
    expect(await f.t.run((ctx) =>
      ctx.db.query("planning_salaries_affectations").collect()))
      .toHaveLength(0);
  });

  test("réconcilie une affectation Google externe sans écraser une saga locale", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        date: "2026-09-05",
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 1,
        updatedBy: f.managerId,
        updatedAt: 1,
      });
      await ctx.db.insert("planning_salaries_sync", {
        saison: "2026-27",
        cle: "google_calendar",
        statut: "en_cours",
        verrouJusqua: 1_000,
        updatedAt: 100,
      });
    });
    const evenement = {
      date: "2026-09-05",
      debut: "2026-09-05T12:00:00+02:00",
      fin: "2026-09-05T14:00:00+02:00",
      groupe: "Groupe 1",
      titre: "Groupe 1",
      googleCalendarId: "calendar@example.test",
      googleEventId: "event-1",
      googleOccurrenceStart: "2026-09-05T12:00:00+02:00",
      currentResourceCalendarId: PLACEHOLDER_RESOURCE,
    };
    await f.t.mutation(internal.planningSalaries.syncDb.appliquerSync, {
      saison: "2026-27",
      startedAt: 100,
      acteurUserId: f.managerId,
      evenements: [evenement],
    });
    expect(await f.t.run((ctx) => ctx.db.query("planning_salaries_affectations").collect())).toHaveLength(0);
    await f.t.run(async (ctx) => {
      const affectationId = await ctx.db.insert("planning_salaries_affectations", {
        saison: "2026-27",
        date: "2026-09-05",
        salarieId: f.aliceId,
        resourceCalendarIdSnapshot: "alice@resource.calendar.google.com",
        createdBy: f.managerId,
        createdAt: 2,
        updatedBy: f.managerId,
        updatedAt: 2,
      });
      const sync = await ctx.db.query("planning_salaries_sync")
        .withIndex("by_saison_and_cle", (q) => q.eq("saison", "2026-27").eq("cle", "google_calendar")).unique();
      if (sync) await ctx.db.patch(sync._id, { statut: "en_cours", updatedAt: 200 });
      await ctx.db.insert("planning_salaries_google_operations", {
        saison: "2026-27",
        date: "2026-09-05",
        creneauId: f.creneauId,
        affectationId,
        type: "remplacer_ressource",
        idempotencyKey: "pending-test",
        sourceResourceCalendarId: PLACEHOLDER_RESOURCE,
        targetResourceCalendarId: "alice@resource.calendar.google.com",
        statut: "a_traiter",
        tentatives: 0,
        createdAt: 2,
        updatedAt: 2,
      });
    });
    await f.t.mutation(internal.planningSalaries.syncDb.appliquerSync, {
      saison: "2026-27",
      startedAt: 200,
      acteurUserId: f.managerId,
      evenements: [evenement],
    });
    expect(await f.t.run((ctx) => ctx.db.query("planning_salaries_affectations").collect())).toHaveLength(1);
  });
});
