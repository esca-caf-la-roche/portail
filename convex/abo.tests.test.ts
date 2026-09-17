/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type PersonneOptions = {
  age?: number | null;
  testAutonomie?: "non_requis" | "requis" | "valide";
  licence?: string;
  vagueDepot?: "vague_2" | "vague_3" | "historique";
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
      vague_depot: options.vagueDepot,
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
  licence = "748012345678",
  avecSnapshotComplet = true,
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
    if (avecSnapshotComplet) {
      const snapshotAt = new Date().toISOString();
      for (const cle of [
        "last_sync_scrap",
        "last_attempt_sync_club",
        "last_complete_sync_club",
      ]) {
        await ctx.db.insert("abo_app_config", {
          cle,
          valeur: snapshotAt,
          updated_at: snapshotAt,
        });
      }
    }
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

    const vue = await t.withIdentity({ subject: bobId }).query(
      api.abo.tests.vueCreneauxAdmin,
      {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    );
    expect(vue.tranches.every((tranche) =>
      JSON.stringify(tranche.staff) === JSON.stringify([
        "Alice Martin",
        "Bob Dupont",
        "Nom à compléter",
      ])
    )).toBe(true);
    expect(JSON.stringify(vue.tranches)).not.toContain("@example.test");
    expect(JSON.stringify(vue.tranches)).not.toContain(aliceId);
  });

  test("consolide les places prises et disponibles par tranche et au total", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t, {
      email: "encadrant@example.test",
      name: "Encadrant Test",
    });
    const { personneId } = await creerPersonne(t, { licence: "748000000111" });
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "11:40",
      });
      await ctx.db.insert("abo_test_reservations", {
        personne_id: personneId,
        tranche: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T09:00:00.000Z",
        statut: "active",
        etat_confirmation: "confirmee",
      });
    });

    const vue = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.vueCreneauxAdmin,
      {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    );

    expect(vue.disponibilitesEquipe).toEqual([{
      creneauId: expect.any(String),
      date_jour: "2099-06-02",
      heure_debut: "10:00",
      heure_fin: "11:40",
      participants: [{ nomAffiche: "Encadrant Test", estMoi: true }],
      monCreneauId: expect.any(String),
    }]);
    expect(vue.tranches.map(({ tranche_debut, tranche_fin, capacite, prises, disponibles }) => ({
      tranche_debut, tranche_fin, capacite, prises, disponibles,
    }))).toEqual([
      { tranche_debut: "2099-06-02T08:00:00.000Z", tranche_fin: "2099-06-02T08:20:00.000Z", capacite: 2, prises: 1, disponibles: 1 },
      { tranche_debut: "2099-06-02T08:20:00.000Z", tranche_fin: "2099-06-02T08:40:00.000Z", capacite: 2, prises: 0, disponibles: 2 },
      { tranche_debut: "2099-06-02T08:40:00.000Z", tranche_fin: "2099-06-02T09:00:00.000Z", capacite: 2, prises: 0, disponibles: 2 },
      { tranche_debut: "2099-06-02T09:00:00.000Z", tranche_fin: "2099-06-02T09:20:00.000Z", capacite: 2, prises: 0, disponibles: 2 },
      { tranche_debut: "2099-06-02T09:20:00.000Z", tranche_fin: "2099-06-02T09:40:00.000Z", capacite: 2, prises: 0, disponibles: 2 },
    ]);
    expect(vue.tranches[0]?.inscrits).toEqual([expect.objectContaining({
      personne_id: personneId,
      tranche_debut: "2099-06-02T08:00:00.000Z",
      tranche_fin: "2099-06-02T09:00:00.000Z",
    })]);
    expect(vue.total).toEqual({ capacite: 10, prises: 1, disponibles: 9 });
    expect(vue.total.prises + vue.total.disponibles).toBe(vue.total.capacite);
  });

  test("conserve une tranche future issue d'une disponibilité déjà commencée", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t, {
      email: "encadrant@example.test",
      name: "Encadrant Test",
    });
    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: adminId,
      date_jour: "2099-06-02",
      heure_debut: "10:00",
      heure_fin: "12:00",
    }));

    const vue = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.vueCreneauxAdmin,
      {
        dateDebut: "2099-06-02",
        instantReference: "2099-06-02T08:30:00.000Z",
      },
    );

    expect(vue.disponibilitesEquipe).toEqual([]);
    expect(vue.tranches.map((tranche) => tranche.tranche_debut)).toEqual([
      "2099-06-02T08:20:00.000Z",
      "2099-06-02T08:40:00.000Z",
      "2099-06-02T09:00:00.000Z",
      "2099-06-02T09:20:00.000Z",
      "2099-06-02T09:40:00.000Z",
    ]);
    expect(vue.tranches.every((tranche) => tranche.capacite === 2)).toBe(true);
    expect(vue.total).toEqual({ capacite: 10, prises: 0, disponibles: 10 });
  });

  test("garde des slots stables de 20 minutes avec des disponibilités qui se chevauchent", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, { email: "alice-slots@example.test" });
    const bobId = await creerAdminAbo(t, { email: "bob-slots@example.test" });
    const candidat = await creerPersonne(t);
    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: aliceId,
      date_jour: "2099-06-02",
      heure_debut: "10:00",
      heure_fin: "11:00",
    }));

    const caller = t.withIdentity({ subject: candidat.userId });
    const avant = await caller.query(api.abo.tests.testCreneauxDisponibles, {});
    expect(avant.map((slot) => [slot.tranche_debut, slot.capacite])).toEqual([
      ["2099-06-02T08:00:00.000Z", 2],
      ["2099-06-02T08:20:00.000Z", 2],
      ["2099-06-02T08:40:00.000Z", 2],
    ]);

    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: bobId,
      date_jour: "2099-06-02",
      heure_debut: "10:20",
      heure_fin: "11:20",
    }));
    const apres = await caller.query(api.abo.tests.testCreneauxDisponibles, {});
    expect(apres.map((slot) => [slot.tranche_debut, slot.tranche_fin, slot.capacite])).toEqual([
      ["2099-06-02T08:00:00.000Z", "2099-06-02T08:20:00.000Z", 2],
      ["2099-06-02T08:20:00.000Z", "2099-06-02T08:40:00.000Z", 4],
      ["2099-06-02T08:40:00.000Z", "2099-06-02T09:00:00.000Z", 4],
      ["2099-06-02T09:00:00.000Z", "2099-06-02T09:20:00.000Z", 2],
    ]);
    expect(apres.slice(0, 3).map((slot) => slot.tranche_debut))
      .toEqual(avant.map((slot) => slot.tranche_debut));
  });

  test("répartit les réservations historiques sans doublon et priorise le slot atomique", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "11:00",
      });
      for (let index = 0; index < 5; index++) {
        await ctx.db.insert("abo_test_reservations", {
          candidat_licence: `74800000004${index}`,
          candidat_nom: `Legacy ${index}`,
          candidat_prenom: "Test",
          candidat_email: `legacy-${index}@example.test`,
          tranche: "2099-06-02T08:00:00.000Z",
          tranche_fin: index % 2 === 0
            ? "2099-06-02T09:00:00.000Z"
            : "2099-06-02T08:40:00.000Z",
          statut: "active",
          etat_confirmation: "confirmee",
        });
      }
      await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748000000049",
        candidat_nom: "Atomique",
        candidat_prenom: "Test",
        candidat_email: "atomique@example.test",
        tranche: "2099-06-02T08:20:00.000Z",
        tranche_fin: "2099-06-02T08:40:00.000Z",
        statut: "active",
        etat_confirmation: "confirmee",
      });
    });

    const vue = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.vueCreneauxAdmin,
      { dateDebut: "2099-01-01", instantReference: "2099-01-01T00:00:00.000Z" },
    );
    expect(vue.tranches.map((slot) => slot.prises)).toEqual([2, 2, 2]);
    const ids = vue.tranches.flatMap((slot) => slot.inscrits.map((inscrit) => inscrit.reservationId));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(vue.tranches[1]?.inscrits).toEqual(expect.arrayContaining([
      expect.objectContaining({ nom: "Atomique" }),
    ]));
  });

  test("alloue d'abord les fenêtres historiques qui finissent le plus tôt", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "11:00",
      });
      for (let index = 0; index < 6; index++) {
        await ctx.db.insert("abo_test_reservations", {
          candidat_licence: `74800000005${index}`,
          candidat_nom: `EDF ${index}`,
          candidat_prenom: "Test",
          candidat_email: `edf-${index}@example.test`,
          tranche: "2099-06-02T08:00:00.000Z",
          tranche_fin: index < 2
            ? "2099-06-02T09:00:00.000Z"
            : "2099-06-02T08:40:00.000Z",
          statut: "active",
        });
      }
    });

    const vue = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.vueCreneauxAdmin,
      { dateDebut: "2099-01-01", instantReference: "2099-01-01T00:00:00.000Z" },
    );
    expect(vue.tranches.map((slot) => slot.prises)).toEqual([2, 2, 2]);
    expect(vue.total).toEqual({ capacite: 6, prises: 6, disponibles: 0 });
  });

  test("déplace un legacy ancien pour accueillir des réservations atomiques plus récentes", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const candidat = await creerPersonne(t);
    const secondCandidat = await creerPersonne(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "10:40",
      });
      await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748000000061",
        candidat_nom: "Legacy ancien",
        candidat_prenom: "Test",
        candidat_email: "legacy-ancien@example.test",
        tranche: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T08:40:00.000Z",
        statut: "active",
      });
    });

    const disponibilites = await t.withIdentity({ subject: candidat.userId }).query(
      api.abo.tests.testCreneauxDisponibles,
      {},
    );
    expect(disponibilites[0]).toMatchObject({
      tranche_debut: "2099-06-02T08:00:00.000Z",
      disponible: 2,
    });

    await t.withIdentity({ subject: candidat.userId }).mutation(
      api.abo.tests.reserverTest,
      { personneId: candidat.personneId, tranche: "2099-06-02T08:00:00.000Z" },
    );
    await t.withIdentity({ subject: secondCandidat.userId }).mutation(
      api.abo.tests.reserverTest,
      { personneId: secondCandidat.personneId, tranche: "2099-06-02T08:00:00.000Z" },
    );
    const vue = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.vueCreneauxAdmin,
      { dateDebut: "2099-01-01", instantReference: "2099-01-01T00:00:00.000Z" },
    );
    expect(vue.tranches.map((slot) => slot.prises)).toEqual([2, 1]);
    expect(vue.tranches[0]?.inscrits.map((inscrit) => inscrit.personne_id).sort()).toEqual([
      candidat.personneId,
      secondCandidat.personneId,
    ].sort());
    expect(vue.tranches[1]?.inscrits).toEqual([
      expect.objectContaining({ nom: "Legacy ancien" }),
    ]);
  });

  test("reproduit la topologie PROD 17 h 40–20 h avec 27 réservations legacy", async () => {
    const t = convexTest(schema, modules);
    const admins = await Promise.all([
      creerAdminAbo(t, { email: "prod-a@example.test", name: "Prod A" }),
      creerAdminAbo(t, { email: "prod-b@example.test", name: "Prod B" }),
      creerAdminAbo(t, { email: "prod-c@example.test", name: "Prod C" }),
      creerAdminAbo(t, { email: "prod-d@example.test", name: "Prod D" }),
    ]);
    await t.run(async (ctx) => {
      for (const adminId of admins.slice(0, 2)) {
        await ctx.db.insert("abo_test_creneaux", {
          admin_id: adminId,
          date_jour: "2099-06-02",
          heure_debut: "17:40",
          heure_fin: "20:00",
        });
      }
      for (const adminId of admins.slice(2)) {
        await ctx.db.insert("abo_test_creneaux", {
          admin_id: adminId,
          date_jour: "2099-06-02",
          heure_debut: "19:00",
          heure_fin: "19:40",
        });
      }
      const groupes = [
        { nombre: 8, debut: "2099-06-02T15:40:00.000Z", fin: "2099-06-02T16:40:00.000Z" },
        { nombre: 6, debut: "2099-06-02T16:40:00.000Z", fin: "2099-06-02T17:20:00.000Z" },
        { nombre: 6, debut: "2099-06-02T17:00:00.000Z", fin: "2099-06-02T18:00:00.000Z" },
        { nombre: 7, debut: "2099-06-02T17:20:00.000Z", fin: "2099-06-02T18:00:00.000Z" },
      ];
      let index = 0;
      for (const groupe of groupes) {
        for (let dansGroupe = 0; dansGroupe < groupe.nombre; dansGroupe++) {
          await ctx.db.insert("abo_test_reservations", {
            candidat_licence: `748000001${String(index).padStart(2, "0")}`,
            candidat_nom: `PROD ${index}`,
            candidat_prenom: "Test",
            candidat_email: `prod-${index}@example.test`,
            tranche: groupe.debut,
            tranche_fin: groupe.fin,
            statut: "active",
            etat_confirmation: "confirmee",
          });
          index++;
        }
      }
    });

    const vue = await t.withIdentity({ subject: admins[0] }).query(
      api.abo.tests.vueCreneauxAdmin,
      { dateDebut: "2099-01-01", instantReference: "2099-01-01T00:00:00.000Z" },
    );
    expect(vue.tranches.map((slot) => slot.capacite)).toEqual([4, 4, 4, 4, 8, 8, 4]);
    expect(vue.total).toEqual({ capacite: 36, prises: 27, disponibles: 9 });
    const reservationsVisibles = vue.tranches.flatMap((slot) =>
      slot.inscrits.map((inscrit) => inscrit.reservationId)
    );
    expect(reservationsVisibles).toHaveLength(27);
    expect(new Set(reservationsVisibles).size).toBe(27);
  });

  test("refuse la vue consolidée à un administrateur sans tuile Abonnements", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "sans-tuile@example.test" });
      await ctx.db.insert("userSettings", {
        userId: id,
        allowedTiles: [],
        role: "admin",
      });
      return id;
    });

    await expect(t.withIdentity({ subject: userId }).query(
      api.abo.tests.vueCreneauxAdmin,
      {
        dateDebut: "2099-01-01",
        instantReference: "2099-01-01T00:00:00.000Z",
      },
    )).rejects.toThrow("Réservé aux administrateurs");
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
    expect(tranches[0]?.capacite).toBe(2);

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

  test("réserve le suivi consolidé aux administrateurs Abonnements", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await creerPersonne(t);

    await expect(
      t.withIdentity({ subject: userId }).query(
        api.abo.tests.suiviCandidatsAdmin,
        { instantReference: "2099-01-01T00:00:00.000Z" },
      ),
    ).rejects.toThrow("Réservé aux administrateurs");
  });

  test("consolide attente, réservation et passage sans doubler une licence", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const attente = await creerPersonne(t, { licence: "748000000001" });
    const reserve = await creerPersonne(t, { licence: "748000000002" });
    const passe = await creerPersonne(t, { licence: "748000000003" });

    await t.run(async (ctx) => {
      await ctx.db.insert("abo_eleves_en_cours", {
        licence: "748000000001",
        nom: "Candidate",
        prenom: "Test",
        nom_prenom_normalise: "candidate test",
        imported_at: "2099-01-01T00:00:00.000Z",
      });
      await ctx.db.insert("abo_eleves_en_cours", {
        licence: "748000000002",
        nom: "Candidate",
        prenom: "Test",
        nom_prenom_normalise: "candidate test",
        imported_at: "2099-01-01T00:00:00.000Z",
      });
      await ctx.db.insert("abo_test_candidats_directs", {
        user_id: attente.userId,
        licence: "748000000001",
        nom: "Candidate",
        prenom: "Test",
        statut: "eligible",
        valide_le: 1,
      });
      await ctx.db.insert("abo_test_reservations", {
        personne_id: reserve.personneId,
        tranche: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T08:40:00.000Z",
        statut: "active",
      });
      await ctx.db.insert("abo_test_reservations", {
        personne_id: passe.personneId,
        tranche: "2098-06-02T08:00:00.000Z",
        tranche_fin: "2098-06-02T08:40:00.000Z",
        statut: "active",
      });
      await ctx.db.insert("abo_tests_autonomie_archive", {
        licence: "748000000003",
        nom: "Candidate",
        prenom: "Test",
        nom_prenom_normalise: "candidate test",
        drive_file_id: "drive-test",
        drive_url: "https://drive.example.test/test",
        statut: "traite",
      });
      await ctx.db.insert("abo_tests_autonomie_archive", {
        licence: "748000000004",
        nom: "ARCHIVE",
        prenom: "Alex",
        nom_prenom_normalise: "archive alex",
        drive_file_id: "drive-archive-only",
        drive_url: "https://drive.example.test/archive-only",
        statut: "a_traiter",
      });
    });

    const suivi = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.suiviCandidatsAdmin,
      { instantReference: "2099-01-01T00:00:00.000Z" },
    );

    expect(suivi).toMatchObject({
      total: 4,
      reserves: 1,
      avecMoniteur: 1,
      sansReservation: 0,
      valides: 1,
      nonValides: 0,
      absents: 0,
      aQualifier: 1,
    });
    expect(suivi.candidats).toEqual(expect.arrayContaining([
      expect.objectContaining({
        licence: "748000000001",
        estEleveEnCours: true,
        statut: "avec_moniteur",
        trancheDebut: null,
        trancheFin: null,
      }),
      expect.objectContaining({
        licence: "748000000002",
        estEleveEnCours: true,
        statut: "reserve",
        trancheDebut: "2099-06-02T08:00:00.000Z",
        trancheFin: "2099-06-02T08:40:00.000Z",
      }),
      expect.objectContaining({
        licence: "748000000003",
        statut: "valide",
        trancheDebut: "2098-06-02T08:00:00.000Z",
        trancheFin: "2098-06-02T08:40:00.000Z",
      }),
      expect.objectContaining({
        licence: "748000000004",
        statut: "a_qualifier",
        trancheDebut: null,
        trancheFin: null,
      }),
    ]));
  });

  test("bascule le suivi en passé à la fin effective avec fallback legacy de 60 minutes", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const moderne = await creerPersonne(t, { licence: "748000000021" });
    const legacy = await creerPersonne(t, { licence: "748000000022" });
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_reservations", {
        personne_id: moderne.personneId,
        tranche: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T08:20:00.000Z",
        statut: "active",
      });
      await ctx.db.insert("abo_test_reservations", {
        personne_id: legacy.personneId,
        tranche: "2099-06-02T08:00:00.000Z",
        statut: "active",
      });
    });
    const admin = t.withIdentity({ subject: adminId });

    const avantFin = await admin.query(api.abo.tests.suiviCandidatsAdmin, {
      instantReference: "2099-06-02T08:19:59.999Z",
    });
    expect(avantFin.candidats.find((c) => c.licence === "748000000021")?.statut).toBe("reserve");
    const aLaFin = await admin.query(api.abo.tests.suiviCandidatsAdmin, {
      instantReference: "2099-06-02T08:20:00.000Z",
    });
    expect(aLaFin.candidats.find((c) => c.licence === "748000000021")?.statut).toBe("a_qualifier");
    expect(aLaFin.candidats.find((c) => c.licence === "748000000022")?.statut).toBe("reserve");
    const finLegacy = await admin.query(api.abo.tests.suiviCandidatsAdmin, {
      instantReference: "2099-06-02T09:00:00.000Z",
    });
    expect(finLegacy.candidats.find((c) => c.licence === "748000000022")?.statut).toBe("a_qualifier");
  });

  test.each(["non_valide", "absent"] as const)(
    "autorise une nouvelle réservation après un résultat %s",
    async (resultat) => {
      const t = convexTest(schema, modules);
      const { userId, personneId } = await creerPersonne(t, { licence: "748000000031" });
      await creerCreneau(t, "2099-06-02");
      await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
        personne_id: personneId,
        tranche: "2020-01-01T08:00:00.000Z",
        tranche_fin: "2020-01-01T08:20:00.000Z",
        statut: "active",
        resultat_test: resultat,
      }));
      const caller = t.withIdentity({ subject: userId });

      await expect(caller.mutation(api.abo.tests.reserverTest, {
        personneId,
        tranche: await trancheDisponible(caller),
      })).resolves.toBeNull();
      const actives = await t.run(async (ctx) =>
        (await ctx.db.query("abo_test_reservations")
          .withIndex("by_personne", (q) => q.eq("personne_id", personneId))
          .collect())
          .filter((reservation) => reservation.statut === "active"),
      );
      expect(actives).toHaveLength(2);
      expect(actives.some((reservation) => reservation.tranche.startsWith("2099-"))).toBe(true);
    },
  );

  test("refuse une nouvelle réservation après un test validé", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { licence: "748000000032" });
    await creerCreneau(t, "2099-06-02");
    await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      personne_id: personneId,
      tranche: "2020-01-01T08:00:00.000Z",
      tranche_fin: "2020-01-01T08:20:00.000Z",
      statut: "active",
      resultat_test: "valide",
    }));
    const caller = t.withIdentity({ subject: userId });

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).rejects.toThrow("réservation active");
  });

  test("répartit chaque personne dans un statut exclusif dont la somme égale le total", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const licences = Array.from({ length: 7 }, (_, index) => `74800000004${index}`);
    await t.run(async (ctx) => {
      for (const [index, licence] of licences.entries()) {
        await ctx.db.insert("abo_test_candidats_directs", {
          user_id: `direct-${index}`,
          licence,
          nom: `Candidat ${index}`,
          prenom: "Test",
          statut: "eligible",
          valide_le: 1,
        });
      }
      await ctx.db.insert("abo_eleves_en_cours", {
        licence: licences[2],
        nom: "Candidat 2",
        prenom: "Test",
        nom_prenom_normalise: "candidat 2 test",
        imported_at: "2099-01-01T00:00:00.000Z",
      });
      await ctx.db.insert("abo_test_reservations", {
        candidat_licence: licences[1], candidat_nom: "Candidat 1", candidat_prenom: "Test",
        candidat_email: "reserve@example.test", tranche: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T08:20:00.000Z", statut: "active",
      });
      for (const [index, resultat] of [
        [3, undefined],
        [4, "valide"],
        [5, "non_valide"],
        [6, "absent"],
      ] as const) {
        await ctx.db.insert("abo_test_reservations", {
          candidat_licence: licences[index], candidat_nom: `Candidat ${index}`,
          candidat_prenom: "Test", candidat_email: `passe-${index}@example.test`,
          tranche: "2098-06-02T08:00:00.000Z", tranche_fin: "2098-06-02T08:20:00.000Z",
          statut: "active", ...(resultat ? { resultat_test: resultat } : {}),
        });
      }
    });

    const suivi = await t.withIdentity({ subject: adminId }).query(
      api.abo.tests.suiviCandidatsAdmin,
      { instantReference: "2099-01-01T00:00:00.000Z" },
    );
    expect(suivi).toMatchObject({
      total: 7,
      reserves: 1,
      avecMoniteur: 1,
      sansReservation: 1,
      valides: 1,
      nonValides: 1,
      absents: 1,
      aQualifier: 1,
    });
    expect(
      suivi.reserves + suivi.avecMoniteur + suivi.sansReservation + suivi.valides
      + suivi.nonValides + suivi.absents + suivi.aQualifier,
    ).toBe(suivi.total);
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

  test("accepte une disponibilité staff minimale de 20 minutes", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const admin = t.withIdentity({ subject: adminId });

    await expect(admin.mutation(api.abo.tests.creerTestCreneau, {
      date: "2099-06-02",
      debut: "10:00",
      fin: "10:20",
    })).resolves.toEqual(expect.any(String));
    const vue = await admin.query(api.abo.tests.vueCreneauxAdmin, {
      dateDebut: "2099-01-01",
      instantReference: "2099-01-01T00:00:00.000Z",
    });
    expect(vue.tranches).toEqual([
      expect.objectContaining({
        tranche_debut: "2099-06-02T08:00:00.000Z",
        tranche_fin: "2099-06-02T08:20:00.000Z",
        capacite: 2,
      }),
    ]);
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

  test("annule en LIFO le surbooking après retrait d'un encadrant", async () => {
    const t = convexTest(schema, modules);
    const aliceId = await creerAdminAbo(t, { email: "alice-lifo@example.test" });
    const bobId = await creerAdminAbo(t, { email: "bob-lifo@example.test" });
    const personnes = await Promise.all([
      creerPersonne(t, { licence: "748000000031" }),
      creerPersonne(t, { licence: "748000000032" }),
      creerPersonne(t, { licence: "748000000033" }),
    ]);
    const { bobCreneauId, reservationIds, autreJourId, orphelineId } = await t.run(async (ctx) => {
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: aliceId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "10:20",
      });
      const bobCreneauId = await ctx.db.insert("abo_test_creneaux", {
        admin_id: bobId,
        date_jour: "2099-06-02",
        heure_debut: "10:00",
        heure_fin: "10:20",
      });
      const reservationIds = [] as Id<"abo_test_reservations">[];
      for (const personne of personnes) {
        reservationIds.push(await ctx.db.insert("abo_test_reservations", {
          personne_id: personne.personneId,
          tranche: "2099-06-02T08:00:00.000Z",
          tranche_fin: "2099-06-02T08:20:00.000Z",
          statut: "active",
        }));
      }
      await ctx.db.insert("abo_test_creneaux", {
        admin_id: aliceId,
        date_jour: "2099-06-03",
        heure_debut: "10:00",
        heure_fin: "10:20",
      });
      const autreJourId = await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748000000081",
        candidat_nom: "Autre jour",
        candidat_prenom: "Test",
        candidat_email: "autre-jour@example.test",
        tranche: "2099-06-03T08:00:00.000Z",
        tranche_fin: "2099-06-03T08:20:00.000Z",
        statut: "active",
      });
      const orphelineId = await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748000000082",
        candidat_nom: "Orpheline",
        candidat_prenom: "Test",
        candidat_email: "orpheline@example.test",
        tranche: "2099-06-04T08:00:00.000Z",
        tranche_fin: "2099-06-04T08:20:00.000Z",
        statut: "active",
      });
      return { bobCreneauId, reservationIds, autreJourId, orphelineId };
    });

    await expect(t.withIdentity({ subject: bobId }).mutation(
      api.abo.tests.supprimerTestCreneau,
      { creneauId: bobCreneauId },
    )).resolves.toBe(1);
    const reservations = await t.run((ctx) => Promise.all(
      reservationIds.map((reservationId) => ctx.db.get(reservationId)),
    ));
    expect(reservations.map((reservation) => reservation?.statut)).toEqual([
      "active",
      "active",
      "annulee",
    ]);
    expect(reservations[2]).toMatchObject({ annulee_raison: "creneau_admin_annule" });
    await expect(t.run(async (ctx) => ({
      autreJour: (await ctx.db.get(autreJourId))?.statut,
      orpheline: (await ctx.db.get(orphelineId))?.statut,
    }))).resolves.toEqual({ autreJour: "active", orpheline: "active" });
  });

  test("ne désinscrit pas une réservation terminée lors du retrait de son ancien créneau", async () => {
    const t = convexTest(schema, modules);
    const adminId = await creerAdminAbo(t);
    const { creneauId, reservationId } = await t.run(async (ctx) => {
      const creneauId = await ctx.db.insert("abo_test_creneaux", {
        admin_id: adminId,
        date_jour: "2020-06-02",
        heure_debut: "10:00",
        heure_fin: "10:20",
      });
      const reservationId = await ctx.db.insert("abo_test_reservations", {
        candidat_licence: "748000000083",
        candidat_nom: "Passée",
        candidat_prenom: "Test",
        candidat_email: "passee@example.test",
        tranche: "2020-06-02T08:00:00.000Z",
        tranche_fin: "2020-06-02T08:20:00.000Z",
        statut: "active",
      });
      return { creneauId, reservationId };
    });

    await expect(t.withIdentity({ subject: adminId }).mutation(
      api.abo.tests.supprimerTestCreneau,
      { creneauId },
    )).resolves.toBe(0);
    await expect(t.run(async (ctx) => (await ctx.db.get(reservationId))?.statut))
      .resolves.toBe("active");
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
    expect(reservations[0]?.active?.annulation_autorisee).toBe(true);
    expect(Date.parse(reservations[0]!.active!.tranche_fin!)
      - Date.parse(reservations[0]!.active!.tranche)).toBe(20 * 60 * 1_000);
  });

  test("affiche sur la personne une réservation directe de même licence sans transférer son annulation", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, {
      licence: "748020279190",
    });
    const reservationId = await t.run(async (ctx) => {
      await ctx.db.patch(personneId, {
        nom: "GUIGO",
        prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA",
        licence_statut: "annuaire_valide",
      });
      const candidatUserId = await ctx.db.insert("users", {
        email: "candidate-directe@example.test",
      });
      return await ctx.db.insert("abo_test_reservations", {
        candidat_user_id: candidatUserId,
        candidat_licence: "748020279190",
        candidat_nom: "GUIGO",
        candidat_prenom: "Olivia",
        candidat_email: "candidate-directe@example.test",
        tranche: "2099-06-02T08:00:00.000Z",
        statut: "active",
        etat_confirmation: "confirmee",
      });
    });

    const reservations = await t.withIdentity({ subject: userId })
      .query(api.abo.tests.getMesReservationsParPersonne, {});

    expect(reservations).toEqual([
      expect.objectContaining({
        personne_id: personneId,
        active: expect.objectContaining({
          id: reservationId,
          etat_confirmation: "confirmee",
          annulation_autorisee: false,
        }),
      }),
    ]);
  });

  test("empêche le candidat direct d'annuler une tentative déjà qualifiée", async () => {
    const t = convexTest(schema, modules);
    const userId = await creerCandidatDirect(t);
    const reservationId = await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      candidat_user_id: userId,
      candidat_licence: "748012345678",
      candidat_nom: "DIRECT",
      candidat_prenom: "Camille",
      candidat_email: "direct@example.test",
      tranche: "2020-06-02T08:00:00.000Z",
      tranche_fin: "2020-06-02T08:20:00.000Z",
      statut: "active",
      resultat_test: "absent",
    }));
    const caller = t.withIdentity({ subject: userId });

    await expect(caller.query(api.abo.tests.getMesReservationsDirectes, {}))
      .resolves.toEqual([]);
    await expect(caller.mutation(api.abo.tests.annulerMaReservationDirecte, {
      reservationId,
    })).rejects.toThrow("ne peut plus être annulée");
    await expect(t.run(async (ctx) => ctx.db.get(reservationId))).resolves.toMatchObject({
      statut: "active",
      resultat_test: "absent",
    });
  });

  test("ne propose plus d'annuler un créneau direct terminé avant sa qualification", async () => {
    const t = convexTest(schema, modules);
    const userId = await creerCandidatDirect(t);
    const reservationId = await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      candidat_user_id: userId,
      candidat_licence: "748012345678",
      candidat_nom: "DIRECT",
      candidat_prenom: "Camille",
      candidat_email: "direct@example.test",
      tranche: "2020-06-02T08:00:00.000Z",
      tranche_fin: "2020-06-02T08:20:00.000Z",
      statut: "active",
    }));
    const caller = t.withIdentity({ subject: userId });

    await expect(caller.query(api.abo.tests.getMesReservationsDirectes, {
      maintenantMs: Date.parse("2020-06-02T08:21:00.000Z"),
    })).resolves.toEqual([
      expect.objectContaining({
        id: reservationId,
        annulation_autorisee: false,
      }),
    ]);
    await expect(caller.mutation(api.abo.tests.annulerMaReservationDirecte, {
      reservationId,
    })).rejects.toThrow("ne peut plus être annulée");
  });

  test("préserve la tentative qualifiée quand le titulaire demande une annulation", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t);
    const reservationId = await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      personne_id: personneId,
      tranche: "2020-06-02T08:00:00.000Z",
      tranche_fin: "2020-06-02T08:20:00.000Z",
      statut: "active",
      resultat_test: "non_valide",
    }));

    await expect(t.withIdentity({ subject: userId }).mutation(
      api.abo.tests.annulerMaReservation,
      { personneId },
    )).resolves.toBeNull();
    await expect(t.run(async (ctx) => ctx.db.get(reservationId))).resolves.toMatchObject({
      statut: "active",
      resultat_test: "non_valide",
    });
  });

  test("affiche un créneau dossier terminé comme non annulable avant sa qualification", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t);
    await t.run((ctx) => ctx.db.insert("abo_test_reservations", {
      personne_id: personneId,
      tranche: "2020-06-02T08:00:00.000Z",
      tranche_fin: "2020-06-02T08:20:00.000Z",
      statut: "active",
    }));

    const reservations = await t.withIdentity({ subject: userId }).query(
      api.abo.tests.getMesReservationsParPersonne,
      { maintenantMs: Date.parse("2020-06-02T08:21:00.000Z") },
    );
    expect(reservations[0]?.active?.annulation_autorisee).toBe(false);
  });

  test("n'expose pas une réservation directe sur une licence seulement saisie", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { licence: "748020279190" });
    await t.run(async (ctx) => {
      await ctx.db.patch(personneId, {
        nom: "GUIGO",
        prenom: "Olivia",
        nom_prenom_normalise: "GUIGO OLIVIA",
      });
      const candidatUserId = await ctx.db.insert("users", {
        email: "candidate-directe@example.test",
      });
      await ctx.db.insert("abo_test_reservations", {
        candidat_user_id: candidatUserId,
        candidat_licence: "748020279190",
        candidat_nom: "GUIGO",
        candidat_prenom: "Olivia",
        candidat_email: "candidate-directe@example.test",
        tranche: "2099-06-02T08:00:00.000Z",
        statut: "active",
        etat_confirmation: "confirmee",
      });
    });

    await expect(t.withIdentity({ subject: userId })
      .query(api.abo.tests.getMesReservationsParPersonne, {}))
      .resolves.toEqual([]);
  });

  test("n'expose pas une réservation directe d'une autre identité avec une licence validée", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, { licence: "748020279190" });
    await t.run(async (ctx) => {
      await ctx.db.patch(personneId, { licence_statut: "annuaire_valide" });
      const candidatUserId = await ctx.db.insert("users", {
        email: "candidate-directe@example.test",
      });
      await ctx.db.insert("abo_test_reservations", {
        candidat_user_id: candidatUserId,
        candidat_licence: "748020279190",
        candidat_nom: "GUIGO",
        candidat_prenom: "Olivia",
        candidat_email: "candidate-directe@example.test",
        tranche: "2099-06-02T08:00:00.000Z",
        statut: "active",
        etat_confirmation: "confirmee",
      });
    });

    await expect(t.withIdentity({ subject: userId })
      .query(api.abo.tests.getMesReservationsParPersonne, {}))
      .resolves.toEqual([]);
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

  test("refuse une personne de vague 2 même absente du snapshot des élèves en cours", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, {
      licence: "L-VAGUE-2",
      vagueDepot: "vague_2",
    });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).rejects.toThrow("demandez à votre moniteur");
    await expect(t.run((ctx) =>
      ctx.db
        .query("abo_eleves_en_cours")
        .withIndex("by_licence", (q) => q.eq("licence", "L-VAGUE-2"))
        .first(),
    )).resolves.toBeNull();
  });

  test("conserve le contrôle du snapshot pour les personnes de vague 3", async () => {
    const t = convexTest(schema, modules);
    const { userId, personneId } = await creerPersonne(t, {
      licence: "L-VAGUE-3",
      vagueDepot: "vague_3",
    });
    const caller = t.withIdentity({ subject: userId });
    await creerCreneau(t, "2099-06-02");
    await t.run((ctx) => ctx.db.insert("abo_eleves_en_cours", {
      licence: "L-VAGUE-3",
      nom_prenom_normalise: "candidate test",
      imported_at: new Date().toISOString(),
    }));

    await expect(caller.mutation(api.abo.tests.reserverTest, {
      personneId,
      tranche: await trancheDisponible(caller),
    })).rejects.toThrow("demandez à votre moniteur");
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
    rateLimiterTest.register(t);
    const adminId = await creerAdminAbo(t);
    const candidatId = await creerCandidatDirect(t);
    const admin = t.withIdentity({ subject: adminId });
    const candidat = t.withIdentity({ subject: candidatId });
    const creneauId = await creerCreneau(t, "2099-06-02", adminId);

    const rattachement = await candidat.mutation(
      api.abo.tests.verifierEtMemoriserCandidatDirect,
      { licence: "7480 1234 5678" },
    );
    if (!rattachement.candidat || !("id" in rattachement.candidat)) throw new Error("Candidat non mémorisé");

    await candidat.mutation(api.abo.tests.reserverTestDirect, {
      candidatId: rattachement.candidat.id,
      tranche: await trancheDisponible(candidat),
    });

    const inscrits = await admin.query(api.abo.tests.testInscritsAdmin, {});
    expect(inscrits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        personne_id: null,
        licence: "748012345678",
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
        licence: "748012345678",
        nom: "DIRECT",
        prenom: "Camille",
        reservationPassee: true,
      }),
    ]));

    const reservation = await t.run((ctx) =>
      ctx.db
        .query("abo_test_reservations")
        .withIndex("by_candidat_licence", (q) => q.eq("candidat_licence", "748012345678"))
        .unique(),
    );
    expect(reservation?.rappel_prevu_le).toBeTruthy();

    await admin.mutation(api.abo.tests.supprimerTestCreneau, { creneauId });
    const annulee = await t.run((ctx) => ctx.db.get(reservation!._id));
    expect(annulee).toMatchObject({
      statut: "annulee",
      annulee_raison: "creneau_admin_annule",
    });
  }, 10_000);

  test("canonise la licence avant l'éligibilité et la réservation directes", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatId });
    await creerCreneau(t, "2099-06-02");

    const eligibilite = await candidat.query(
      api.abo.tests.eligibiliteReservationDirecteTest,
      { licence: "7480 1234 5678 99", maintenantMs: Date.now() },
    );
    expect(eligibilite).toMatchObject({
      autorisee: true,
      motif: "eligible",
      candidat: { licence: "748012345678" },
    });

    const rattachement = await candidat.mutation(
      api.abo.tests.verifierEtMemoriserCandidatDirect,
      { licence: "7480-1234-5678-99" },
    );
    if (!rattachement.candidat || !("id" in rattachement.candidat)) throw new Error("Candidat non mémorisé");

    await candidat.mutation(api.abo.tests.reserverTestDirect, {
      candidatId: rattachement.candidat.id,
      tranche: await trancheDisponible(candidat),
    });
    const reservation = await t.run((ctx) =>
      ctx.db
        .query("abo_test_reservations")
        .withIndex("by_candidat_licence", (q) =>
          q.eq("candidat_licence", "748012345678"),
        )
        .unique(),
    );
    expect(reservation?.candidat_licence).toBe("748012345678");
  });

  test("refuse une réservation directe si la licence a ensuite été liée à une personne de vague 2", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatUserId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatUserId });
    await creerCreneau(t, "2099-06-02");
    const rattachement = await candidat.mutation(
      api.abo.tests.verifierEtMemoriserCandidatDirect,
      { licence: "748012345678" },
    );
    if (!rattachement.candidat || !("id" in rattachement.candidat)) {
      throw new Error("Candidat non mémorisé");
    }

    await creerPersonne(t, {
      licence: "748012345678",
      vagueDepot: "vague_2",
    });

    await expect(candidat.mutation(api.abo.tests.reserverTestDirect, {
      candidatId: rattachement.candidat.id,
      tranche: await trancheDisponible(candidat),
    })).rejects.toThrow("demandez à votre moniteur");
    await expect(t.run((ctx) =>
      ctx.db
        .query("abo_eleves_en_cours")
        .withIndex("by_licence", (q) => q.eq("licence", "748012345678"))
        .first(),
    )).resolves.toBeNull();
  });

  test("mémorise le licencié sur le compte et ouvre un seul lot d'alerte de 30 minutes", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatUserId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatUserId });
    const rattachement = await candidat.mutation(
      api.abo.tests.verifierEtMemoriserCandidatDirect,
      { licence: "748012345678" },
    );
    if (!rattachement.candidat || !("id" in rattachement.candidat)) throw new Error("Candidat non mémorisé");

    await candidat.mutation(api.abo.testNotifications.suivreCandidatDirect, {
      candidatId: rattachement.candidat.id,
      actif: true,
    });
    const adminId = await creerAdminAbo(t);
    const admin = t.withIdentity({ subject: adminId });
    const premier = await admin.mutation(api.abo.tests.creerTestCreneau, {
      date: "2099-06-02",
      debut: "10:00",
      fin: "10:40",
    });
    await admin.mutation(api.abo.tests.creerTestCreneau, {
      date: "2099-06-02",
      debut: "11:00",
      fin: "11:40",
    });

    const etat = await t.run(async (ctx) => ({
      candidats: await ctx.db.query("abo_test_candidats_directs").collect(),
      lots: await ctx.db.query("abo_test_notification_lots").collect(),
      creneau: await ctx.db.get(premier),
    }));
    expect(etat.candidats).toEqual([
      expect.objectContaining({ licence: "748012345678", nom: "DIRECT", prenom: "Camille" }),
    ]);
    expect(etat.lots).toHaveLength(1);
    expect(etat.lots[0]?.envoi_prevu_le - etat.lots[0]?.ouvert_le).toBe(30 * 60 * 1_000);
    expect(etat.creneau?.notification_lot_id).toBe(etat.lots[0]?._id);
  });

  test("refuse explicitement une licence directe invalide", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatId });

    await expect(
      candidat.query(api.abo.tests.eligibiliteReservationDirecteTest, {
        licence: "1234",
        maintenantMs: Date.now(),
      }),
    ).resolves.toMatchObject({
      autorisee: false,
      motif: "licence_invalide",
      message: expect.stringContaining("12 ou 14 chiffres"),
      candidat: null,
    });
    await expect(
      candidat.mutation(api.abo.tests.verifierEtMemoriserCandidatDirect, {
        licence: "1234",
      }),
    ).resolves.toMatchObject({ autorisee: false, motif: "licence_invalide" });
  });

  test("refuse de mémoriser une licence directe sans snapshot club complet", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(
      t,
      "748012345678",
      false,
    );
    const candidat = t.withIdentity({ subject: candidatId });
    await creerCreneau(t, "2099-06-02");

    await expect(
      candidat.mutation(api.abo.tests.verifierEtMemoriserCandidatDirect, {
        licence: "748012345678",
      }),
    ).resolves.toMatchObject({ autorisee: false, motif: "snapshot_a_actualiser" });
  });

  test("refuse de mémoriser une licence directe avec un snapshot club trop ancien", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatId });
    await creerCreneau(t, "2099-06-02");
    const ancienSnapshot = new Date(Date.now() - 16 * 60_000).toISOString();
    await t.run(async (ctx) => {
      for (const cle of [
        "last_sync_scrap",
        "last_attempt_sync_club",
        "last_complete_sync_club",
      ]) {
        const row = await ctx.db
          .query("abo_app_config")
          .withIndex("by_cle", (q) => q.eq("cle", cle))
          .unique();
        await ctx.db.patch(row!._id, {
          valeur: ancienSnapshot,
          updated_at: ancienSnapshot,
        });
      }
    });

    await expect(
      candidat.mutation(api.abo.tests.verifierEtMemoriserCandidatDirect, {
        licence: "748012345678",
      }),
    ).resolves.toMatchObject({ autorisee: false, motif: "snapshot_a_actualiser" });
  });

  test("autorise une licence familiale associée à un autre email", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t);
    const candidat = t.withIdentity({ subject: candidatId });
    await creerCreneau(t, "2099-06-02");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748099999999",
        nom: "AUTRE",
        prenom: "Personne",
        nom_prenom_normalise: "AUTRE PERSONNE",
        email: "autre@example.test",
        age: 30,
        autonomie: "Doit passer le test",
        abonnement_valide: "oui",
        last_scrap_at: new Date().toISOString(),
      });
    });

    const autreEmail = await candidat.query(
      api.abo.tests.eligibiliteReservationDirecteTest,
      { licence: "748099999999", maintenantMs: Date.now() },
    );
    expect(autreEmail).toMatchObject({
      autorisee: true,
      motif: "eligible",
      candidat: {
        licence: "748099999999",
        nom: "AUTRE",
        prenom: "Personne",
      },
    });

    const rattachement = await candidat.mutation(
      api.abo.tests.verifierEtMemoriserCandidatDirect,
      { licence: "748099999999" },
    );
    if (!rattachement.candidat || !("id" in rattachement.candidat)) throw new Error("Candidat non mémorisé");

    await candidat.mutation(api.abo.tests.reserverTestDirect, {
      candidatId: rattachement.candidat.id,
      tranche: await trancheDisponible(candidat),
    });
    const reservation = await t.run((ctx) =>
      ctx.db
        .query("abo_test_reservations")
        .withIndex("by_candidat_licence", (q) =>
          q.eq("candidat_licence", "748099999999"),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      candidat_email: "direct@example.test",
      candidat_nom: "AUTRE",
      candidat_prenom: "Personne",
    });
  });

  test("la synchronisation directe réutilise le verrou global sans exposer les compteurs", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t, "748012345678", false);
    const derniereSync = new Date().toISOString();
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", {
        cle: "last_sync_scrap",
        valeur: derniereSync,
        updated_at: derniereSync,
      });
      await ctx.db.insert("abo_app_config", {
        cle: "last_complete_sync_club",
        valeur: derniereSync,
        updated_at: derniereSync,
      });
      await ctx.db.insert("abo_app_config", {
        cle: "last_attempt_sync_club",
        valeur: derniereSync,
        updated_at: derniereSync,
      });
    });

    const resultat = await t
      .withIdentity({ subject: candidatId })
      .action(api.abo.scrap.synchroniserPourTestAutonomieDirect, {
        licence: "7480 1234 5678",
      });

    expect(resultat).toEqual({
      statut: "skipped",
      retryAt: new Date(Date.parse(derniereSync) + 5 * 60_000).toISOString(),
      licence: "748012345678",
    });
    expect(resultat).not.toHaveProperty("abonnes");
    expect(resultat).not.toHaveProperty("eleves");
  });

  test("un verrou sans marqueur de complétion est signalé en cours", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(t, "748012345678", false);
    const tentativeAt = new Date().toISOString();
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", {
        cle: "last_sync_scrap",
        valeur: tentativeAt,
        updated_at: tentativeAt,
      });
    });

    const resultat = await t
      .withIdentity({ subject: candidatId })
      .action(api.abo.scrap.synchroniserPourTestAutonomieDirect, {
        licence: "748012345678",
      });

    expect(resultat).toMatchObject({
      statut: "en_cours",
      licence: "748012345678",
    });
  });

  test("une restauration admin ne revalide pas un snapshot partiellement remplacé", async () => {
    const t = convexTest(schema, modules);
    const ancienSnapshot = "2020-01-01T00:00:00.000Z";
    await t.run(async (ctx) => {
      for (const cle of [
        "last_sync_scrap",
        "last_attempt_sync_club",
        "last_complete_sync_club",
      ]) {
        await ctx.db.insert("abo_app_config", {
          cle,
          valeur: ancienSnapshot,
          updated_at: ancienSnapshot,
        });
      }
    });

    const reservation = await t.mutation(internal.abo.sync.reserverSyncClub, {
      ttlMs: 5 * 60_000,
    });
    expect(reservation).toMatchObject({ proceed: true, complete: false });
    await t.mutation(internal.abo.sync.restaurerMarqueurSiTentativeCourante, {
      cle: "last_sync_scrap",
      tentativeAt: reservation.tentativeAt!,
      valeur: ancienSnapshot,
    });

    await expect(
      t.query(internal.abo.sync.etatSyncClubInterne, {}),
    ).resolves.toMatchObject({ complete: false });
  });

  test("une ancienne tentative ne peut pas restaurer le verrou d'une nouvelle", async () => {
    const t = convexTest(schema, modules);
    const nouvelleTentative = new Date().toISOString();
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", {
        cle: "last_sync_scrap",
        valeur: nouvelleTentative,
        updated_at: nouvelleTentative,
      });
    });

    await expect(
      t.mutation(internal.abo.sync.restaurerMarqueurSiTentativeCourante, {
        cle: "last_sync_scrap",
        tentativeAt: "2020-01-01T00:00:00.000Z",
        valeur: "2019-01-01T00:00:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      t.run((ctx) =>
        ctx.db
          .query("abo_app_config")
          .withIndex("by_cle", (q) => q.eq("cle", "last_sync_scrap"))
          .unique(),
      ),
    ).resolves.toMatchObject({ valeur: nouvelleTentative });
  });

  test("un échec public restaure le verrou sans rendre la tentative complète ni restituer le rate limit", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const candidatId = await creerCandidatDirect(
      t,
      "748012345678",
      false,
    );
    const candidat = t.withIdentity({ subject: candidatId });
    const anciennesVariables = {
      base: process.env.CLUB_BASE_URL,
      username: process.env.CLUB_USERNAME,
      password: process.env.CLUB_PASSWORD,
    };
    delete process.env.CLUB_BASE_URL;
    delete process.env.CLUB_USERNAME;
    delete process.env.CLUB_PASSWORD;

    try {
      await expect(
        candidat.action(api.abo.scrap.synchroniserPourTestAutonomieDirect, {
          licence: "748012345678",
        }),
      ).resolves.toMatchObject({ statut: "erreur" });

      const apresEchec = await t.query(
        internal.abo.sync.etatSyncClubInterne,
        {},
      );
      expect(apresEchec).toMatchObject({ verrouAt: null, complete: false });
      const tentativeApresEchec = await t.run((ctx) =>
        ctx.db
          .query("abo_app_config")
          .withIndex("by_cle", (q) => q.eq("cle", "last_attempt_sync_club"))
          .unique(),
      );
      expect(tentativeApresEchec?.valeur).toBeTruthy();

      await expect(
        candidat.action(api.abo.scrap.synchroniserPourTestAutonomieDirect, {
          licence: "748012345678",
        }),
      ).resolves.toMatchObject({ statut: "erreur" });
      const tentativeApresSecondAppel = await t.run((ctx) =>
        ctx.db
          .query("abo_app_config")
          .withIndex("by_cle", (q) => q.eq("cle", "last_attempt_sync_club"))
          .unique(),
      );
      expect(tentativeApresSecondAppel?.valeur).toBe(
        tentativeApresEchec?.valeur,
      );
    } finally {
      if (anciennesVariables.base === undefined) delete process.env.CLUB_BASE_URL;
      else process.env.CLUB_BASE_URL = anciennesVariables.base;
      if (anciennesVariables.username === undefined) delete process.env.CLUB_USERNAME;
      else process.env.CLUB_USERNAME = anciennesVariables.username;
      if (anciennesVariables.password === undefined) delete process.env.CLUB_PASSWORD;
      else process.env.CLUB_PASSWORD = anciennesVariables.password;
    }
  });

  test("la synchronisation directe refuse un compte hors Abonnements avant le scrap", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "autre-portail@example.test" }),
    );

    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.abo.scrap.synchroniserPourTestAutonomieDirect, {
          licence: "748012345678",
        }),
    ).rejects.toThrow("compte Abonnements");
  });
});
