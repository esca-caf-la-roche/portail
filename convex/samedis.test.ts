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
import {
  construireEmailNotificationSamedis,
  echapperHtml,
  formaterDateCivileFrancaise,
  humaniserDatesDansTexte,
} from "./samedis/notifications";

const modules = import.meta.glob("./**/*.ts");

describe("e-mails de notification des samedis", () => {
  test("présente les dates civiles avec leur vrai jour en français", () => {
    expect(formaterDateCivileFrancaise("2027-05-15")).toBe("Samedi 15 mai 2027");
    expect(humaniserDatesDansTexte("Période : 2026-09-07 au 2027-06-25.")).toBe(
      "Période : Lundi 7 septembre 2026 au Vendredi 25 juin 2027.",
    );
    expect(formaterDateCivileFrancaise("2027-02-30")).toBe("2027-02-30");
  });

  test("compose un HTML néo-brutaliste sûr avec un fallback texte", () => {
    const email = construireEmailNotificationSamedis({
      typeModification: "reservation_creee",
      acteur: 'gestionnaire+<test>"@example.test',
      saison: "2026-27",
      resume: '2027-05-15 — <script>alert("x")</script> & confirmé.',
      createdAt: Date.UTC(2027, 4, 1, 10, 30),
    });

    expect(email.sujet).toBe(
      "Samedis après-midi — Réservation créée — saison 2026-27",
    );
    expect(email.texte).toContain("Samedi 15 mai 2027");
    expect(email.texte).toContain("Réservation créée");
    expect(email.html).toContain("border:4px solid #111111");
    expect(email.html).toContain("background:#b9f56a");
    expect(email.html).toContain("Samedi 15 mai 2027");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; confirmé.");
    expect(email.html).not.toContain("<script>");
    expect(echapperHtml("<&>'\"")).toBe("&lt;&amp;&gt;&#039;&quot;");
  });
});

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

async function appliquerBlocagesOfficiels(
  f: Awaited<ReturnType<typeof fixture>>,
  startedAt: number,
  blocages: Array<{
    date: string;
    motifs: string[];
    sources: Array<"ferie" | "vacances">;
  }>,
) {
  await f.t.run(async (ctx) => {
    const configuration = await ctx.db
      .query("samedis_configurations")
      .withIndex("by_saison", (q) => q.eq("saison", "2026-27"))
      .unique();
    if (!configuration) throw new Error("Configuration de test absente.");
    await ctx.db.patch(configuration._id, { derniereSynchronisation: startedAt });
  });
  return await f.t.mutation(internal.samedis.sync.appliquerSync, {
    saison: "2026-27",
    acteurUserId: f.managerId,
    startedAt,
    blocages,
  });
}

describe("ouvertures exceptionnelles des samedis officiellement bloqués", () => {
  test("ouvre une date de vacances et permet ensuite sa réservation normale", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 10, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires : vacances d'été"],
      sources: ["vacances"],
    }]);

    const manager = f.t.withIdentity({ subject: f.managerId });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      ouvertureManuelle: true,
    });

    const calendrierManager = await manager.query(
      api.samedis.calendrier.forManager,
      { saison: "2026-27" },
    );
    expect(calendrierManager.creneaux[0]).toMatchObject({
      estBloque: false,
      blocageOfficiel: true,
      blocageManuel: false,
      ouvertureManuelle: true,
    });
    const participant = f.t.withIdentity({ subject: f.participantUserId });
    const calendrierParticipant = await participant.query(
      api.samedis.calendrier.forParticipant,
      { saison: "2026-27" },
    );
    expect(calendrierParticipant.creneaux[0]).toMatchObject({
      estBloque: false,
      sourcesBlocage: ["vacances"],
    });
    const reservationId = await participant.mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau1 },
    );
    expect(await f.t.run((ctx) => ctx.db.get(reservationId))).toMatchObject({
      forcee: false,
      mode: "participant",
    });
  });

  test("conserve l'exception au resync puis la nettoie avec le blocage officiel", async () => {
    const f = await fixture("ok");
    const blocageVacances = [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires : vacances d'été"],
      sources: ["vacances" as const],
    }];
    await appliquerBlocagesOfficiels(f, 20, blocageVacances);
    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      {
        creneauId: f.creneau1,
        bloqueManuellement: false,
        ouvertureManuelle: true,
      },
    );

    expect(await appliquerBlocagesOfficiels(f, 21, blocageVacances)).toBe(0);
    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: false,
      ouvertureManuelle: true,
      sourcesBlocage: ["vacances"],
    });

    expect(await appliquerBlocagesOfficiels(f, 22, [])).toBe(1);
    const nettoye = await f.t.run((ctx) => ctx.db.get(f.creneau1));
    expect(nettoye).toMatchObject({
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
    });
    expect(nettoye?.ouvertureManuelle).toBeUndefined();

    expect(await appliquerBlocagesOfficiels(f, 23, blocageVacances)).toBe(1);
    const rebloque = await f.t.run((ctx) => ctx.db.get(f.creneau1));
    expect(rebloque).toMatchObject({
      estBloque: true,
      sourcesBlocage: ["vacances"],
    });
    expect(rebloque?.ouvertureManuelle).toBeUndefined();
  });

  test("ne réécrit ni ne notifie un samedi officiel soumis sans changement", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 25, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires : vacances d'été"],
      sources: ["vacances"],
    }]);
    const avant = await f.t.run(async (ctx) => ({
      creneau: await ctx.db.get(f.creneau1),
      notifications: await ctx.db.query("samedis_notifications").take(100),
    }));

    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      {
        creneauId: f.creneau1,
        bloqueManuellement: false,
        ouvertureManuelle: false,
      },
    );

    const apres = await f.t.run(async (ctx) => ({
      creneau: await ctx.db.get(f.creneau1),
      notifications: await ctx.db.query("samedis_notifications").take(100),
    }));
    expect(apres.creneau).toEqual(avant.creneau);
    expect(apres.creneau?.updatedAt).toBe(avant.creneau?.updatedAt);
    expect(apres.creneau?.modificationManuelle).toBeUndefined();
    expect(apres.notifications).toEqual(avant.notifications);
  });

  test("refuse une exception sans source officielle ou avec un blocage manuel", async () => {
    const f = await fixture("ok");
    const manager = f.t.withIdentity({ subject: f.managerId });
    await expect(manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      ouvertureManuelle: true,
    })).rejects.toThrow("réservée aux samedis bloqués par le calendrier officiel");

    await appliquerBlocagesOfficiels(f, 30, [{
      date: "2026-09-05",
      motifs: ["Jour férié : fête nationale"],
      sources: ["ferie"],
    }]);
    await expect(manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: true,
      motif: "Fermeture du club",
      ouvertureManuelle: true,
    })).rejects.toThrow("à la fois bloqué manuellement et rendu disponible");
  });

  test("réserve l'ouverture exceptionnelle aux gestionnaires authentifiés", async () => {
    const f = await fixture("ok");
    const args = {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      ouvertureManuelle: true,
    };

    await expect(f.t.mutation(
      api.samedis.admin.updateCreneau,
      args,
    )).rejects.toThrow("Non autorisé");
    await expect(f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.admin.updateCreneau,
      args,
    )).rejects.toThrow("Accès refusé");
  });

  test("conserve un blocage manuel combiné aux sources officielles pendant les resyncs", async () => {
    const f = await fixture("ok");
    const blocageFerie = [{
      date: "2026-09-05",
      motifs: ["Jour férié : fête nationale"],
      sources: ["ferie" as const],
    }];
    await appliquerBlocagesOfficiels(f, 35, blocageFerie);
    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      {
        creneauId: f.creneau1,
        bloqueManuellement: true,
        motif: "Fermeture du club",
        ouvertureManuelle: false,
      },
    );

    expect(await appliquerBlocagesOfficiels(f, 36, blocageFerie)).toBe(0);
    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: true,
      motifsBlocage: ["Jour férié : fête nationale", "Fermeture du club"],
      sourcesBlocage: ["ferie", "manuel"],
    });

    expect(await appliquerBlocagesOfficiels(f, 37, [])).toBe(1);
    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: true,
      motifsBlocage: ["Fermeture du club"],
      sourcesBlocage: ["manuel"],
    });
  });

  test("refuse de retirer l'exception tant qu'une réservation normale existe", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 40, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires : vacances d'été"],
      sources: ["vacances"],
    }]);
    const manager = f.t.withIdentity({ subject: f.managerId });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      ouvertureManuelle: true,
    });
    await f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.reservations.reserver,
      { saison: "2026-27", creneauId: f.creneau1 },
    );

    await expect(manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      ouvertureManuelle: false,
    })).rejects.toThrow("avant de rétablir ce blocage");
    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: false,
      ouvertureManuelle: true,
    });
  });

  test("traite les anciennes lignes sans champ comme non ouvertes et sans réécriture", async () => {
    const f = await fixture("ok");
    const avant = await f.t.run((ctx) => ctx.db.get(f.creneau1));
    expect(avant?.ouvertureManuelle).toBeUndefined();

    expect(await appliquerBlocagesOfficiels(f, 50, [])).toBe(0);
    const apres = await f.t.run((ctx) => ctx.db.get(f.creneau1));
    expect(apres?.ouvertureManuelle).toBeUndefined();
    expect(apres?.updatedAt).toBe(avant?.updatedAt);

    const calendrier = await f.t.withIdentity({ subject: f.managerId }).query(
      api.samedis.calendrier.forManager,
      { saison: "2026-27" },
    );
    expect(calendrier.creneaux[0]).toMatchObject({
      estBloque: false,
      blocageOfficiel: false,
      ouvertureManuelle: false,
    });
  });
});

describe("commentaires internes des blocages officiels", () => {
  test("conserve la note de compétition sans modifier le blocage et la masque aux participants", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 60, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires : vacances d'été"],
      sources: ["vacances"],
    }]);
    const manager = f.t.withIdentity({ subject: f.managerId });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "compétition de badminton",
    });

    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: true,
      motifsBlocage: ["Vacances scolaires : vacances d'été"],
      sourcesBlocage: ["vacances"],
      commentaireBlocage: "compétition de badminton",
    });
    const calendrierManager = await manager.query(
      api.samedis.calendrier.forManager,
      { saison: "2026-27" },
    );
    expect(calendrierManager.creneaux[0]?.commentaireBlocage).toBe(
      "compétition de badminton",
    );
    const calendrierParticipant = await f.t
      .withIdentity({ subject: f.participantUserId })
      .query(api.samedis.calendrier.forParticipant, { saison: "2026-27" });
    expect(calendrierParticipant.creneaux[0]).not.toHaveProperty("commentaireBlocage");

    expect(await appliquerBlocagesOfficiels(f, 61, [])).toBe(1);
    expect(await f.t.run((ctx) => ctx.db.get(f.creneau1))).toMatchObject({
      estBloque: false,
      motifsBlocage: [],
      sourcesBlocage: [],
      commentaireBlocage: "compétition de badminton",
    });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "Gymnase réservé au badminton",
    });
    expect((await f.t.run((ctx) => ctx.db.get(f.creneau1)))?.commentaireBlocage).toBe(
      "Gymnase réservé au badminton",
    );
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "   ",
    });
    expect((await f.t.run((ctx) => ctx.db.get(f.creneau1)))?.commentaireBlocage).toBeUndefined();
  });

  test("normalise, limite et efface le commentaire", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 70, [{
      date: "2026-09-05",
      motifs: ["Jour férié : fermeture"],
      sources: ["ferie"],
    }]);
    const manager = f.t.withIdentity({ subject: f.managerId });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: `  ${"a".repeat(500)}  `,
    });
    expect((await f.t.run((ctx) => ctx.db.get(f.creneau1)))?.commentaireBlocage).toBe(
      "a".repeat(500),
    );
    await expect(manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "a".repeat(501),
    })).rejects.toThrow("limité à 500 caractères");
    expect((await f.t.run((ctx) => ctx.db.get(f.creneau1)))?.commentaireBlocage).toBe(
      "a".repeat(500),
    );
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "",
    });
    expect((await f.t.run((ctx) => ctx.db.get(f.creneau1)))?.commentaireBlocage).toBeUndefined();
  });

  test("refuse une nouvelle note sur un samedi ordinaire et aux non-gestionnaires", async () => {
    const f = await fixture("ok");
    const args = {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "Compétition de badminton",
    };
    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      args,
    )).rejects.toThrow("seulement être créé sur un samedi bloqué");

    await appliquerBlocagesOfficiels(f, 80, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires"],
      sources: ["vacances"],
    }]);
    await expect(f.t.mutation(api.samedis.admin.updateCreneau, args)).rejects.toThrow(
      "Non autorisé",
    );
    await expect(f.t.withIdentity({ subject: f.participantUserId }).mutation(
      api.samedis.admin.updateCreneau,
      args,
    )).rejects.toThrow("Accès refusé");
  });

  test("ne réécrit ni ne notifie lorsque le commentaire normalisé est inchangé", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 90, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires"],
      sources: ["vacances"],
    }]);
    const manager = f.t.withIdentity({ subject: f.managerId });
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "Compétition de badminton",
    });
    const avant = await f.t.run(async (ctx) => ({
      creneau: await ctx.db.get(f.creneau1),
      notifications: await ctx.db.query("samedis_notifications").take(100),
    }));
    await manager.mutation(api.samedis.admin.updateCreneau, {
      creneauId: f.creneau1,
      bloqueManuellement: false,
      commentaireBlocage: "  Compétition de badminton  ",
    });
    const apres = await f.t.run(async (ctx) => ({
      creneau: await ctx.db.get(f.creneau1),
      notifications: await ctx.db.query("samedis_notifications").take(100),
    }));
    expect(apres).toEqual(avant);
  });

  test("mentionne la note et l'ouverture exceptionnelle dans la même notification", async () => {
    const f = await fixture("ok");
    await appliquerBlocagesOfficiels(f, 95, [{
      date: "2026-09-05",
      motifs: ["Vacances scolaires"],
      sources: ["vacances"],
    }]);
    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateCreneau,
      {
        creneauId: f.creneau1,
        bloqueManuellement: false,
        ouvertureManuelle: true,
        commentaireBlocage: "Compétition de badminton",
      },
    );

    const notifications = await f.t.run((ctx) =>
      ctx.db.query("samedis_notifications").take(100),
    );
    expect(notifications.find(
      (notification) => notification.typeModification === "creneau_modifie",
    )?.resume).toBe(
      "2026-09-05 — rendu disponible malgré le blocage officiel ; " +
      "commentaire interne de blocage mis à jour.",
    );
  });
});

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

describe("gestion staff des participants aux samedis", () => {
  test("réserve l'édition et la suppression au staff ayant la tuile", async () => {
    const f = await fixture("ok");
    const participant = f.t.withIdentity({ subject: f.participantUserId });

    await expect(f.t.mutation(api.samedis.admin.removeParticipant, {
      participantId: f.autreParticipantId,
    })).rejects.toThrow("Non autorisé");
    await expect(participant.mutation(api.samedis.admin.updateParticipant, {
      participantId: f.autreParticipantId,
      nom: "Bob Modifié",
      email: "bob.modifie@example.test",
      actif: true,
    })).rejects.toThrow("Accès refusé");
    await expect(participant.mutation(api.samedis.admin.removeParticipant, {
      participantId: f.autreParticipantId,
    })).rejects.toThrow("Accès refusé");
  });

  test("modifie les informations d'un participant", async () => {
    const f = await fixture("ok");
    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.updateParticipant,
      {
        participantId: f.participantId,
        nom: "Alice Martin",
        email: "alice.martin@example.test",
        actif: false,
      },
    );

    const participant = await f.t.run((ctx) => ctx.db.get(f.participantId));
    expect(participant).toMatchObject({
      nom: "Alice Martin",
      email: "alice.martin@example.test",
      emailNormalise: "alice.martin@example.test",
      actif: false,
    });
    expect(participant?.userId).toBeUndefined();
  });

  test("refuse la suppression si une réservation existe dans une autre saison", async () => {
    const f = await fixture("ok");
    await f.t.run(async (ctx) => {
      const ancienCreneauId = await ctx.db.insert("samedis_creneaux", {
        saison: "2025-26",
        date: "2025-09-06",
        lieu: "Filière Grimpe",
        estBloque: false,
        motifsBlocage: [],
        sourcesBlocage: [],
        updatedAt: 1,
        updatedBy: f.managerId,
      });
      await ctx.db.insert("samedis_reservations", {
        saison: "2025-26",
        creneauId: ancienCreneauId,
        participantId: f.participantId,
        createdBy: f.participantUserId,
        mode: "participant",
        forcee: false,
        createdAt: 1,
      });
    });

    await expect(f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.removeParticipant,
      { participantId: f.participantId },
    )).rejects.toThrow("saison 2025-26");
    expect(await f.t.run((ctx) => ctx.db.get(f.participantId))).not.toBeNull();
  });

  test("supprime uniquement la fiche participant et journalise l'opération", async () => {
    const f = await fixture("ok");
    await f.t.withIdentity({ subject: f.managerId }).mutation(
      api.samedis.admin.removeParticipant,
      { participantId: f.participantId },
    );

    const resultat = await f.t.run(async (ctx) => ({
      participant: await ctx.db.get(f.participantId),
      utilisateur: await ctx.db.get(f.participantUserId),
      notifications: await ctx.db.query("samedis_notifications").collect(),
    }));
    expect(resultat.participant).toBeNull();
    expect(resultat.utilisateur).not.toBeNull();
    expect(resultat.notifications).toEqual([
      expect.objectContaining({
        typeModification: "participant_supprime",
        acteurUserId: f.managerId,
        destinataire: "escalade@caflarochebonneville.fr",
        resume: "Participant supprimé : Alice <alice@example.test>.",
      }),
    ]);
    const notificationId = resultat.notifications[0]?._id;
    expect(notificationId).toBeDefined();
    if (!notificationId) return;
    const email = await f.t.query(internal.samedis.notifications.contexte, {
      notificationId,
    });
    expect(email?.sujet).toBe("Samedis après-midi — Participant supprimé");
    expect(email?.texte).toContain("Participant supprimé");
    expect(email?.html).toContain("Modification enregistrée");
    expect(email?.html).toContain("Participant supprimé : Alice &lt;alice@example.test&gt;.");
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

  test("compte un seul samedi pour une semaine commencée le vendredi soir", () => {
    expect(samedisBloquesParVacances(
      ["2026-10-17", "2026-10-24", "2026-10-31"],
      [{
        start_date: "2026-10-16",
        end_date: "2026-10-26",
        description: "Une semaine de vacances",
      }],
    )).toEqual(["2026-10-24"]);
  });

  test("compte deux samedis pour deux semaines commencées le vendredi soir", () => {
    expect(samedisBloquesParVacances(
      ["2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"],
      [{
        start_date: "2026-10-16",
        end_date: "2026-11-02",
        description: "Deux semaines de vacances",
      }],
    )).toEqual(["2026-10-24", "2026-10-31"]);
  });

  test("bloque le samedi d'un pont de l'Ascension commencé le mercredi soir", () => {
    expect(samedisBloquesParVacances(
      ["2027-05-01", "2027-05-08", "2027-05-15"],
      [{
        start_date: "2027-05-05",
        end_date: "2027-05-10",
        description: "Pont de l'Ascension",
      }],
    )).toEqual(["2027-05-08"]);
  });

  test("ne bloque jamais le samedi matin de la reprise", () => {
    expect(samediBloqueParPeriodeScolaire(
      "2027-05-08",
      "2027-05-03",
      "2027-05-08",
    )).toBe(false);
    expect(samediBloqueParPeriodeScolaire(
      "2026-10-31",
      "2026-10-16",
      "2026-10-31",
    )).toBe(false);
  });

  test("bloque le samedi d'une période de sept jours commencée le mercredi", () => {
    expect(samedisBloquesParVacances(
      ["2027-05-01", "2027-05-08", "2027-05-15"],
      [{
        start_date: "2027-05-05",
        end_date: "2027-05-12",
        description: "Fermeture d'une semaine",
      }],
    )).toEqual(["2027-05-08"]);
  });

  test("bloque le samedi d'un pont court commencé le vendredi soir", () => {
    expect(samedisBloquesParVacances(
      ["2027-05-01", "2027-05-08", "2027-05-15"],
      [{
        start_date: "2027-05-07",
        end_date: "2027-05-10",
        description: "Pont court",
      }],
    )).toEqual(["2027-05-08"]);
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
