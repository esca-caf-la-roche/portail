/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type PersonneOptions = {
  age?: number | null;
  testAutonomie?: "non_requis" | "requis" | "valide";
  licence?: string;
};

async function creerPersonne(
  t: ReturnType<typeof convexTest>,
  options: PersonneOptions = {},
): Promise<{ userId: Id<"users">; personneId: Id<"abo_personnes"> }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "abo@example.test" });
    await ctx.db.insert("abo_profiles", {
      userId,
      email: "abo@example.test",
      role: "utilisateur",
    });
    const dossierId = await ctx.db.insert("abo_dossiers", {
      email: "abo@example.test",
      statut_dossier: "validee",
      date_soumission: "2026-08-01T00:00:00.000Z",
      owner_id: userId,
    });
    const personneId = await ctx.db.insert("abo_personnes", {
      dossier_id: dossierId,
      nom: "Candidate",
      prenom: "Test",
      nom_prenom_normalise: "candidate test",
      ...(options.age === null ? {} : { age: options.age ?? 16 }),
      licence: options.licence,
      licence_statut: "saisie",
      etape_demande: true,
      etape_validation: "validee",
      etape_licence: false,
      etape_test_autonomie: options.testAutonomie ?? "requis",
      etape_inscription_site: false,
      etape_photo: false,
      etape_paiement: false,
      etape_abonnement_valide: false,
    });
    return { userId, personneId };
  });
}

async function creerCreneau(
  t: ReturnType<typeof convexTest>,
  date: string,
  adminId?: Id<"users">,
): Promise<Id<"abo_test_creneaux">> {
  return await t.run(async (ctx) => {
    const ownerId = adminId ?? await ctx.db.insert("users", {
      email: `admin-${date}@example.test`,
      name: "Admin créneau",
    });
    if (adminId === undefined) {
      await ctx.db.insert("userSettings", {
        userId: ownerId,
        allowedTiles: ["abonnements"],
        role: "user",
      });
    }
    return await ctx.db.insert("abo_test_creneaux", {
      admin_id: ownerId,
      date_jour: date,
      heure_debut: "10:00",
      heure_fin: "10:40",
    });
  });
}

async function creerAdminAbo(
  t: ReturnType<typeof convexTest>,
  options: { email?: string; name?: string | null } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: options.email ?? "admin-abo@example.test",
      ...(options.name === null
        ? {}
        : { name: options.name ?? "Admin Abonnements" }),
    });
    await ctx.db.insert("userSettings", {
      userId,
      allowedTiles: ["abonnements"],
      role: "admin",
    });
    return userId;
  });
}

async function creerCandidatDirect(
  t: ReturnType<typeof convexTest>,
  licence = "DIRECT-123",
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "direct@example.test" });
    await ctx.db.insert("abo_profiles", {
      userId,
      email: "direct@example.test",
      role: "utilisateur",
    });
    await ctx.db.insert("abo_abonnes_scrap", {
      licence,
      nom: "DIRECT",
      prenom: "Camille",
      nom_prenom_normalise: "direct camille",
      email: "direct@example.test",
      age: 20,
      autonomie: "Doit passer le test",
      abonnement_valide: "oui",
      last_scrap_at: new Date().toISOString(),
    });
    return userId;
  });
}

async function trancheDisponible(
  caller: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
): Promise<string> {
  const creneaux = await caller.query(api.abo.tests.testCreneauxDisponibles, {});
  const tranche = creneaux[0]?.tranche_debut;
  if (!tranche) throw new Error("Créneau de test introuvable.");
  return tranche;
}

describe("réservation de test d'autonomie", () => {
  test("partage les créneaux du staff sans exposer les emails", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, {
      email: "alice@example.test",
      name: "Alice Martin",
    });
    const bobId = await creerAdminAbo(t, {
      email: "bob@example.test",
      name: "Bob Dupont",
    });
    const sansNomId = await creerAdminAbo(t, {
      email: "secret@example.test",
      name: null,
    });
    const ancienId = await creerAdminAbo(t, {
      email: "ancien@example.test",
      name: "Ancien Staff",
    });
    await creerCreneau(t, "2099-06-02", aliceId);
    await creerCreneau(t, "2099-06-02", bobId);
    await creerCreneau(t, "2099-06-02", sansNomId);
    await creerCreneau(t, "2098-06-02", ancienId);

    const creneaux = await t
      .withIdentity({ subject: bobId })
      .query(api.abo.tests.getCreneauxStaff, {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      });

    expect(creneaux).toEqual([{
      creneauId: expect.any(String),
      date_jour: "2099-06-02",
      heure_debut: "10:00",
      heure_fin: "10:40",
      participants: [
        { nomAffiche: "Alice Martin", estMoi: false },
        { nomAffiche: "Bob Dupont", estMoi: true },
        { nomAffiche: "Nom à compléter", estMoi: false },
      ],
      monCreneauId: expect.any(String),
    }]);
    expect(JSON.stringify(creneaux)).not.toContain("@example.test");
    expect(JSON.stringify(creneaux)).not.toContain(aliceId);
  });

  test("exclut un ancien staff de la vue, de la capacité et des créneaux rejoignables", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t, {
      email: "actif@example.test",
      name: "Staff actif",
    });
    const ghostId = await t.run((ctx) =>
      ctx.db.insert("users", {
        email: "ancien-staff@example.test",
        name: "Ancien staff",
      }),
    );
    await creerCreneau(t, "2099-06-02", adminId);
    const ghostCreneauId = await creerCreneau(t, "2099-06-02", ghostId);
    const { userId: candidatId } = await creerPersonne(t);

    const vueStaff = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.getCreneauxStaff,
      {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    );
    expect(vueStaff).toHaveLength(1);
    expect(vueStaff[0]?.participants).toEqual([
      { nomAffiche: "Staff actif", estMoi: true },
    ]);

    const tranches = await t.withIdentity({ subject: candidatId }).query(
      api.abo.tests.testCreneauxDisponibles,
      {},
    );
    expect(tranches[0]?.capacite).toBe(4);

    await expect(t.withIdentity({ subject: adminId }).mutation(
      api.abo.tests.rejoindreTestCreneau,
      { creneauId: ghostCreneauId },
    )).rejects.toThrow("n'est plus proposé");
  });

  test("réserve la vue globale et l'ajout aux administrateurs Abonnements", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const creneauId = await creerCreneau(t, "2099-06-02", adminId);
    const { userId } = await creerPersonne(t);
    const nonAdmin = t.withIdentity({ subject: userId });

    await expect(nonAdmin.query(api.abo.tests.getCreneauxStaff, {
      dateDebut: "2099-01-01",
      instantReference: "2099-01-01T00:00:00.000Z",
    })).rejects.toThrow("Réservé aux administrateurs");
    await expect(nonAdmin.mutation(api.abo.tests.rejoindreTestCreneau, {
      creneauId,
    })).rejects.toThrow("Réservé aux administrateurs");
  });

  test("exige un nom configuré pour proposer ou rejoindre un créneau", async () => {
    const t = convexTest(schema, modules);
    const adminNommeId = await creerAdminAbo(t, {
      email: "nomme@example.test",
      name: "Staff nommé",
    });
    const sansNomId = await creerAdminAbo(t, {
      email: "sans-nom@example.test",
      name: null,
    });
    const referenceId = await creerCreneau(t, "2099-06-02", adminNommeId);
    const sansNom = t.withIdentity({ subject: sansNomId });

    await expect(sansNom.mutation(api.abo.tests.creerTestCreneau, {
      date: "2099-06-03",
      debut: "10:00",
      fin: "10:40",
    })).rejects.toThrow("Complétez votre nom");
    await expect(sansNom.mutation(api.abo.tests.rejoindreTestCreneau, {
      creneauId: referenceId,
    })).rejects.toThrow("Complétez votre nom");
  });

  test("valide la date stable de la vue globale", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const admin = t.withIdentity({ subject: adminId });

    await expect(admin.query(api.abo.tests.getCreneauxStaff, {
      dateDebut: "demain",
      instantReference: "2099-01-01T00:00:00.000Z",
    })).rejects.toThrow("AAAA-MM-JJ");
    await expect(admin.query(api.abo.tests.getCreneauxStaff, {
      dateDebut: "2099-01-01",
      instantReference: "maintenant",
    })).rejects.toThrow("ISO invalide");
  });

  test("exclut les plages déjà passées le jour de référence", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t, { name: "Alice Martin" });
    await creerCreneau(t, "2099-06-02", adminId);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2099-06-02",
        heure_debut: "10:40",
        heure_fin: "11:20",
      });
    });

    const creneaux = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.getCreneauxStaff,
      {
        dateDebut: "2099-06-02",
        // En juin, 10 h 20 à Paris correspond à 08 h 20 UTC.
        instantReference: "2099-06-02T08:20:00.000Z",
      },
    );

    expect(creneaux).toHaveLength(1);
    expect(creneaux[0]).toMatchObject({
      heure_debut: "10:40",
      heure_fin: "11:20",
    });
  });

  test("crée et rejoint une plage exacte de façon idempotente", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, {
      email: "alice@example.test",
      name: "Alice Martin",
    });
    const bobId = await creerAdminAbo(t, {
      email: "bob@example.test",
      name: "Bob Dupont",
    });
    const alice = t.withIdentity({ subject: aliceId });
    const bob = t.withIdentity({ subject: bobId });
    const plage = { date: "2099-06-02", debut: "10:00", fin: "10:40" };

    const referenceId = await alice.mutation(api.abo.tests.creerTestCreneau, plage);
    await expect(
      alice.mutation(api.abo.tests.creerTestCreneau, plage),
    ).resolves.toBe(referenceId);

    const monCreneauId = await bob.mutation(api.abo.tests.rejoindreTestCreneau, {
      creneauId: referenceId,
    });
    await expect(bob.mutation(api.abo.tests.rejoindreTestCreneau, {
      creneauId: referenceId,
    })).resolves.toBe(monCreneauId);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("abo_test_creneaux")
        .withIndex("by_date", (q) => q.eq("date_jour", plage.date))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });

  test("préserve l'idempotence au plafond mais refuse une 201e ligne", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, { email: "alice@example.test" });
    const bobId = await creerAdminAbo(t, { email: "bob@example.test" });
    const referenceId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("abo_test_creneaux", {
        admin_id: aliceId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "10:40",
      });
      for (let index = 1; index < 200; index++) {
        await ctx.db.insert("abo_test_creneaux", {
          admin_id: aliceId,
          date_jour: "2099-06-02",
          heure_debut: `autre-${index}`,
          heure_fin: `fin-${index}`,
        });
      }
      return id;
    });

    await expect(t.withIdentity({ subject: aliceId }).mutation(
      api.abo.tests.creerTestCreneau,
      { date: "2099-06-02", debut: "10:00", fin: "10:40" },
    )).resolves.toBe(referenceId);
    await expect(t.withIdentity({ subject: bobId }).mutation(
      api.abo.tests.rejoindreTestCreneau,
      { creneauId: referenceId },
    )).rejects.toThrow("Trop de créneaux");

    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: aliceId,
      date_jour: "2099-06-02",
      heure_debut: "ligne-201",
      heure_fin: "fin-201",
    }));
    await expect(t.withIdentity({ subject: aliceId }).query(
      api.abo.tests.getCreneauxStaff,
      {
        dateDebut: "2099-06-02",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    )).rejects.toThrow("vue complète");
  });

  test("retire tous les doublons historiques exacts du staff", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, {
      email: "alice@example.test",
      name: "Alice Martin",
    });
    const bobId = await creerAdminAbo(t, {
      email: "bob@example.test",
      name: "Bob Dupont",
    });
    const premierAliceId = await creerCreneau(t, "2099-06-02", aliceId);
    await creerCreneau(t, "2099-06-02", aliceId);
    await creerCreneau(t, "2099-06-02", bobId);

    await expect(t.withIdentity({ subject: aliceId }).mutation(
      api.abo.tests.supprimerTestCreneau,
      { creneauId: premierAliceId },
    )).resolves.toBe(0);

    const lignesAlice = await t.run((ctx) => ctx.db
      .query("abo_test_creneaux")
      .withIndex("by_admin", (q) => q.eq("admin_id", aliceId))
      .collect());
    expect(lignesAlice).toHaveLength(0);

    const vue = await t.withIdentity({ subject: bobId }).query(
      api.abo.tests.getCreneauxStaff,
      {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    );
    expect(vue[0]?.participants).toEqual([
      { nomAffiche: "Bob Dupont", estMoi: true },
    ]);
  });

  test("refuse de rejoindre un créneau passé", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, { email: "alice@example.test" });
    const bobId = await creerAdminAbo(t, { email: "bob@example.test" });
    const creneauId = await creerCreneau(t, "2020-06-02", aliceId);

    await expect(t.withIdentity({ subject: bobId }).mutation(
      api.abo.tests.rejoindreTestCreneau,
      { creneauId },
    )).rejects.toThrow("créneau est passé");
  });

  test("refuse un créneau dont l'heure de début est déjà passée aujourd'hui", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const caller = t.withIdentity({ subject: adminId });
    const aujourdHui = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
    }).format(new Date());

    await expect(caller.mutation(api.abo.tests.creerTestCreneau, {
      date: aujourdHui,
      debut: "00:00",
      fin: "00:40",
    })).rejects.toThrow("doit être dans le futur");
  });

  test("autorise provisoirement une personne sans licence", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { testAutonomie: "non_requis" });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).resolves.toBeNull();
    const reservations = await caller.query(api.abo.tests.getMesReservationsParPersonne, {});
    expect(reservations[0]?.active?.etat_confirmation).toBe("provisoire");
  });

  test("autorise provisoirement une personne de moins de 16 ans", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { age: 15 });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).resolves.toBeNull();
  });

  test("refuse une personne dont l'âge n'est pas encore connu", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { age: null });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).resolves.toBeNull();
  });

  test("refuse une personne dont le test est déjà validé", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { testAutonomie: "valide" });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).resolves.toBeNull();
  });

  test("refuse une tranche passée", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t);
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2020-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: "2020-06-02T08:00:00.000Z",
    })).rejects.toThrow("créneau est passé");
  });

  test("autorise une personne de 16 ans avec un test requis sur une tranche future", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { age: 16 });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).resolves.toBeNull();
  });

  test("confirme après un scrap par licence exact, avec autonomie requise et 16 ans", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { age: null, licence: "L-123" });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");
    await caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "L-123",
        nom_prenom_normalise: "candidate test",
        age: 16,
        autonomie: "Doit passer le test",
        abonnement_valide: "oui",
        last_scrap_at: new Date().toISOString(),
      });
      await ctx.runMutation(internal.abo.matching.matcherScrapPersonnes, {});
    });
    const reservations = await caller.query(api.abo.tests.getMesReservationsParPersonne, {});
    expect(reservations[0]?.active?.etat_confirmation).toBe("confirmee");
  });

  test("annule après scrap exact complet si les conditions de test ne sont pas remplies", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { age: null, licence: "L-456" });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");
    await caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "L-456",
        nom_prenom_normalise: "candidate test",
        age: 15,
        autonomie: "Doit passer le test",
        abonnement_valide: "oui",
        last_scrap_at: new Date().toISOString(),
      });
      await ctx.runMutation(internal.abo.matching.matcherScrapPersonnes, {});
    });
    const reservations = await caller.query(api.abo.tests.getMesReservationsParPersonne, {});
    expect(reservations[0]?.active).toBeNull();
    expect(reservations[0]?.annulee?.annulee_raison).toBe("conditions_test_non_remplies");
  });

  test("rend une réservation directe visible au staff, archivable et rappelable", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const candidatId = await creerCandidatDirect(t);
    const admin = t.withIdentity({ subject: adminId });
    const candidat = t.withIdentity({ subject: candidatId });
    const creneauId = await creerCreneau(t, "2099-06-02", adminId);

    await candidat.mutation(api.abo.tests.reserverTestDirect, {
      licence: "DIRECT-123",
      tranche: await trancheDisponible(candidat),
    });

    const inscrits = await admin.query(api.abo.tests.testInscritsAdmin, {});
    expect(inscrits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        personne_id: null,
        licence: "DIRECT-123",
        nom: "DIRECT",
        prenom: "Camille",
        email: "direct@example.test",
        etat_confirmation: "confirmee",
      }),
    ]));

    const aArchiver = await admin.query(api.abo.testDocuments.listeReservationsPassees, {
      avant: "2100-01-01T00:00:00.000Z",
    });
    expect(aArchiver).toEqual(expect.arrayContaining([
      expect.objectContaining({
        personneId: null,
        licence: "DIRECT-123",
        nom: "DIRECT",
        prenom: "Camille",
        reservationPassee: true,
      }),
    ]));

    const reservation = await t.run((ctx) =>
      ctx.db
        .query("abo_test_reservations")
        .withIndex("by_candidat_licence", (q) => q.eq("candidat_licence", "DIRECT-123"))
        .unique(),
    );
    expect(reservation?.rappel_prevu_le).toBeTruthy();

    await admin.mutation(api.abo.tests.supprimerTestCreneau, { creneauId });
    const annulee = await t.run((ctx) => ctx.db.get(reservation!._id));
    expect(annulee).toMatchObject({
      statut: "annulee",
      annulee_raison: "creneau_admin_annule",
    });
  });
});
