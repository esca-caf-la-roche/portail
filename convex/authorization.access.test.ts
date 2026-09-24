/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type TestContext = ReturnType<typeof convexTest>;

async function createUser(
  t: TestContext,
  options: { tiles?: string[]; role?: "admin" | "user" } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: `test-${crypto.randomUUID()}@example.test`,
    });
    if (options.tiles !== undefined || options.role !== undefined) {
      await ctx.db.insert("userSettings", {
        userId,
        allowedTiles: options.tiles ?? [],
        role: options.role ?? "user",
      });
    }
    return userId;
  });
}

async function deniedIdentities(t: TestContext) {
  const [aboUserId, staffUserId, adminUserId] = await Promise.all([
    createUser(t),
    createUser(t, { tiles: [] }),
    createUser(t, { tiles: [], role: "admin" }),
  ]);
  return [
    t.withIdentity({ subject: aboUserId }),
    t.withIdentity({ subject: staffUserId }),
    t.withIdentity({ subject: adminUserId }),
  ];
}

describe("protections des tuiles Comptabilité et Drive", () => {
  test("refusent abo-otp et un admin sans tuile compta", async () => {
    const t = convexTest(schema, modules);
    const [abo, staff, admin] = await deniedIdentities(t);
    const transactionId = await t.run(async (ctx) => {
      const tiersId = await ctx.db.insert("tiers", { nom: "Fournisseur" });
      const analytiqueId = await ctx.db.insert("analytiques", { nom: "Escalade" });
      return await ctx.db.insert("transactions", { nom: "Facture", date: "2026-08-03", realise: 10, tiersId, analytiqueId, saison: "2026-27" });
    });

    for (const identity of [abo, staff, admin]) {
      await expect(identity.query(api.transactions.getStats, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.transactions.remove, { id: transactionId })).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.references.getTiers, {})).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.typesDocuments.create, { nom: "Facture" })).rejects.toThrow("Accès refusé");
      await expect(identity.action(api.drive.processTransactionDrive, { transactionId, saisonDirName: "2026-27", analytiqueNom: "Escalade", date: "2026-08-03", typeDocumentNom: "Facture", tiersNom: "Fournisseur" })).rejects.toThrow("Accès refusé");
    }
  });
});

describe("protections des tuiles Budget", () => {
  test("refusent abo-otp, staff sans tuile et admin sans tuile", async () => {
    const t = convexTest(schema, modules);
    const identities = await deniedIdentities(t);
    const analytiqueId = await t.run((ctx) => ctx.db.insert("analytiques", { nom: "Budget test" }));
    const salarieId = await t.run((ctx) => ctx.db.insert("salaries", { nom: "Moniteur", typeContrat: "CDII" }));

    for (const identity of identities) {
      await expect(identity.query(api.previsionnels.getStats, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.effectifs.getSynthese, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.analytiques.get, {})).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.paie.getMasseSalariale, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.cours.getPlanning, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.previsionnels.add, { nom: "Ligne", montant: 10, etat: false, analytiqueId, saison: "2026-27" })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.effectifs.setMembresLoisir, { saison: "2026-27", nbMembresLoisir: 10 })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.analytiques.add, { nom: "Interdit" })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.paie.addSalarie, { nom: "Interdit", typeContrat: "CDII", saison: "2026-27", nbMois: 12, tauxHoraireBrut: 20 })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.cours.addCours, { saison: "2026-27", nom: "Interdit", tarifAnnuel: 100, nbElevesMax: 10, nbSemaines: 30, moniteurs: [salarieId], seances: [{ jour: 0, heureDebut: "18:00", dureeHeures: 1 }] })).rejects.toThrow("Accès refusé");
    }
  });

  test("autorise la tuile budget en lecture et écriture", async () => {
    const t = convexTest(schema, modules);
    const budget = t.withIdentity({ subject: await createUser(t, { tiles: ["budget"] }) });
    await expect(budget.query(api.previsionnels.getStats, { saison: "2026-27" })).resolves.toBeDefined();
    const analytiqueId = await budget.mutation(api.analytiques.add, { nom: "Autorisé" });
    await expect(budget.mutation(api.previsionnels.add, { nom: "Ligne", montant: 10, etat: false, analytiqueId, saison: "2026-27" })).resolves.toBeDefined();
    await expect(budget.mutation(api.effectifs.setMembresLoisir, { saison: "2026-27", nbMembresLoisir: 10 })).resolves.toBeNull();
    await expect(budget.mutation(api.paie.addSalarie, { nom: "Moniteur", typeContrat: "CDII", saison: "2026-27", nbMois: 12, tauxHoraireBrut: 20 })).resolves.toBeDefined();
  });
});

describe("protections de la tuile Paiements", () => {
  test("refusent abo-otp, staff sans tuile et admin sans tuile", async () => {
    const t = convexTest(schema, modules);
    for (const identity of await deniedIdentities(t)) {
      await expect(identity.query(api.paiements.getLinks, {})).rejects.toThrow("Accès refusé");
      await expect(identity.query(api.paiements.getGroups, {})).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.paiements.addLink, { url: "https://example.test/payer", label: "Cours", is_installment: false })).rejects.toThrow("Accès refusé");
      await expect(identity.mutation(api.paiements.addGroup, { name: "Cours", requires_approval: false, link_ids: [] })).rejects.toThrow("Accès refusé");
    }
  });

  test("autorise la tuile paiements en lecture et écriture", async () => {
    const t = convexTest(schema, modules);
    const paiements = t.withIdentity({ subject: await createUser(t, { tiles: ["paiements"] }) });
    await expect(paiements.query(api.paiements.getLinks, {})).resolves.toEqual([]);
    const linkId = await paiements.mutation(api.paiements.addLink, { url: "https://example.test/payer", label: "Cours", is_installment: false });
    await expect(paiements.mutation(api.paiements.addGroup, { name: "Cours", requires_approval: false, link_ids: [linkId] })).resolves.toBeDefined();
  });
});

describe("saisons et administration globale", () => {
  const tiles = [
    ["compta", "bg-info"], ["paiements", "bg-success"], ["budget", "bg-warning"],
    ["abonnements", "bg-primary"], ["licences_cours", "bg-danger"], ["contacts_cours", "bg-orange"],
    ["remboursements_eleves", "bg-pink"],
    ["samedis", "bg-lime"],
    ["planning_salaries_samedis", "bg-purple"],
  ] as const;
  const configuration = { tiles: tiles.map(([id, color]) => ({ id, color })) };

  test("refusent abo-otp et staff non-admin", async () => {
    const t = convexTest(schema, modules);
    const abo = t.withIdentity({ subject: await createUser(t) });
    const staff = t.withIdentity({ subject: await createUser(t, { tiles: [] }) });
    for (const identity of [abo, staff]) {
      await expect(identity.mutation(api.saisons.create, { nom: "2026-27" })).rejects.toThrow("Réservé aux administrateurs");
      await expect(identity.mutation(api.saisons.createNext, {})).rejects.toThrow("Réservé aux administrateurs");
      await expect(identity.mutation(api.users.updateDashboardConfiguration, configuration)).rejects.toThrow("Réservé aux administrateurs");
      await expect(identity.query(api.users.listUsers, {})).rejects.toThrow("Réservé aux administrateurs");
    }
  });

  test("autorise l'admin de configuration, sans bypass métier", async () => {
    const t = convexTest(schema, modules);
    const admin = t.withIdentity({ subject: await createUser(t, { tiles: [], role: "admin" }) });
    const saisonId = await admin.mutation(api.saisons.create, { nom: "2025-26", isDefault: true });
    await expect(admin.mutation(api.saisons.update, { id: saisonId, isDefault: true })).resolves.toBeNull();
    await expect(admin.mutation(api.saisons.createNext, {})).resolves.toMatchObject({ nom: "2026-27" });
    const removableId = await admin.mutation(api.saisons.create, { nom: "2027-28" });
    await expect(admin.mutation(api.saisons.remove, { id: removableId })).resolves.toBeNull();
    await expect(admin.mutation(api.users.updateDashboardConfiguration, configuration)).resolves.toBeDefined();
    await expect(admin.query(api.users.listUsers, {})).resolves.toBeDefined();
    await expect(admin.query(api.transactions.getStats, { saison: "2026-27" })).rejects.toThrow("Accès refusé");
  });

  test("maintient exactement une saison par défaut", async () => {
    const t = convexTest(schema, modules);
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });

    const premiereId = await admin.mutation(api.saisons.create, { nom: "2025-26" });
    const secondeId = await admin.mutation(api.saisons.create, { nom: "2026-27" });
    let saisons = await admin.query(api.saisons.get, {});
    expect(saisons.filter((s) => s.isDefault)).toHaveLength(1);
    expect(saisons.find((s) => s._id === premiereId)?.isDefault).toBe(true);

    await expect(
      admin.mutation(api.saisons.update, { id: premiereId, isDefault: false }),
    ).rejects.toThrow("Impossible de retirer la saison par défaut");

    await admin.mutation(api.saisons.update, { id: secondeId, isDefault: true });
    saisons = await admin.query(api.saisons.get, {});
    expect(saisons.filter((s) => s.isDefault)).toHaveLength(1);
    expect(saisons.find((s) => s._id === secondeId)?.isDefault).toBe(true);
  });

  test("createNext répare un historique sans saison par défaut", async () => {
    const t = convexTest(schema, modules);
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });
    await t.run((ctx) =>
      ctx.db.insert("saisons", { nom: "2025-26", isDefault: false }),
    );

    await expect(admin.mutation(api.saisons.createNext, {})).resolves.toMatchObject({
      nom: "2026-27",
    });
    const saisons = await admin.query(api.saisons.get, {});
    expect(saisons.filter((s) => s.isDefault)).toHaveLength(1);
    expect(saisons.find((s) => s.nom === "2026-27")?.isDefault).toBe(true);
  });

  test("signale explicitement l'absence de saison par défaut à l'import des cours", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.cours.importPlanning, { replace: false, cours: [] }),
    ).rejects.toThrow("Aucune saison par défaut définie");
  });

  test("réserve l'ajout, la modification et la suppression du staff aux admins", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({
      subject: await createUser(t, { tiles: [] }),
    });
    const targetId = await createUser(t, { tiles: [] });

    await expect(staff.mutation(api.users.addUser, {
      email: "nouveau-staff@example.test",
      name: "Nouveau staff",
    })).rejects.toThrow("Réservé aux administrateurs");
    await expect(staff.mutation(api.users.updateUserSettings, {
      userId: targetId,
      name: "Staff modifié",
      role: "user",
      allowedTiles: [],
      canManageAboConfiguration: false,
    })).rejects.toThrow("Réservé aux administrateurs");
    await expect(staff.mutation(api.users.removeUser, {
      userId: targetId,
    })).rejects.toThrow("Réservé aux administrateurs");
  });

  test("liste uniquement le staff et protège les comptes publics Abonnements", async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { tiles: [], role: "admin" });
    const staffId = await createUser(t, { tiles: ["compta"] });
    const publicId = await createUser(t);
    const publicProfileId = await t.run((ctx) => ctx.db.insert("abo_profiles", {
      userId: publicId,
      email: "public@example.test",
      role: "utilisateur",
    }));
    const admin = t.withIdentity({ subject: adminId });

    const listedIds = (await admin.query(api.users.listUsers, {}))
      .map((user) => user._id);
    expect(listedIds).toContain(adminId);
    expect(listedIds).toContain(staffId);
    expect(listedIds).not.toContain(publicId);

    const modification = admin.mutation(api.users.updateUserSettings, {
      userId: publicId,
      name: "Compte public",
      role: "user",
      allowedTiles: ["compta"],
      canManageAboConfiguration: false,
    });
    await expect(modification).rejects.toThrow("n'est pas un membre du staff");
    await expect(admin.mutation(api.users.removeUser, {
      userId: publicId,
    })).rejects.toThrow("n'est pas un membre du staff");

    expect(await t.run((ctx) => ctx.db.get(publicId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(publicProfileId))).not.toBeNull();
    const publicSettings = await t.run((ctx) => ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", publicId))
      .first());
    expect(publicSettings).toBeNull();
  });

  test("addUser canonise l'email et refuse une collision canonique", async () => {
    const t = convexTest(schema, modules);
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });
    const userId = await admin.mutation(api.users.addUser, {
      email: "  Nouveau.Staff@Example.TEST  ",
      name: "Nouveau staff",
    });
    const user = await t.run(async (ctx) => await ctx.db.get(userId));
    expect(user?.email).toBe("nouveau.staff@example.test");
    await expect(admin.mutation(api.users.addUser, {
      email: "nouveau.staff@example.test",
      name: "Doublon",
    })).rejects.toThrow("existe déjà");

    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: " Legacy.Staff@Example.TEST " });
    });
    await expect(admin.mutation(api.users.addUser, {
      email: "legacy.staff@example.test",
      name: "Doublon legacy",
    })).rejects.toThrow("existe déjà");
  });

  test("autorise la configuration Abonnements à un staff non-admin ayant la tuile", async () => {
    const t = convexTest(schema, modules);
    const targetId = await createUser(t, { tiles: ["abonnements"], role: "admin" });
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });

    await admin.mutation(api.users.updateUserSettings, {
      userId: targetId,
      name: "Responsable campagne",
      role: "user",
      allowedTiles: [],
      canManageAboConfiguration: false,
    });
    await expect(admin.query(api.users.listUsers, {})).resolves.toContainEqual(
      expect.objectContaining({
        _id: targetId,
        settings: expect.objectContaining({
          canManageAboConfiguration: false,
          canResetAboSeason: false,
        }),
      }),
    );

    await admin.mutation(api.users.updateUserSettings, {
      userId: targetId,
      name: "Responsable campagne",
      role: "user",
      allowedTiles: ["abonnements"],
      canManageAboConfiguration: true,
    });
    await expect(admin.query(api.users.listUsers, {})).resolves.toContainEqual(
      expect.objectContaining({
        _id: targetId,
        settings: expect.objectContaining({ canManageAboConfiguration: true }),
      }),
    );
  });

  test("permet à un administrateur d'attribuer le droit de configuration", async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { tiles: ["abonnements"], role: "admin" });
    const admin = t.withIdentity({ subject: adminId });

    await expect(
      admin.mutation(api.users.updateUserSettings, {
        userId: adminId,
        name: "Administrateur",
        role: "admin",
        allowedTiles: ["abonnements"],
        canManageAboConfiguration: true,
      }),
    ).resolves.toBeNull();
    await expect(admin.query(api.users.listUsers, {})).resolves.toContainEqual(
      expect.objectContaining({
        _id: adminId,
        settings: expect.objectContaining({ canManageAboConfiguration: true }),
      }),
    );
  });

  test("bloque le retrait de la tuile Abonnements et la suppression avec un créneau futur", async () => {
    const t = convexTest(schema, modules);
    const targetId = await createUser(t, { tiles: ["abonnements"] });
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });
    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: targetId,
      date_jour: "2099-06-02",
      heure_debut: "10:00",
      heure_fin: "10:40",
    }));

    await expect(admin.mutation(api.users.updateUserSettings, {
      userId: targetId,
      name: "Encadrant",
      role: "user",
      allowedTiles: [],
      canManageAboConfiguration: false,
    })).rejects.toThrow("doit d'abord le retirer");
    await expect(admin.mutation(api.users.removeUser, {
      userId: targetId,
    })).rejects.toThrow("doit d'abord le retirer");

    const settings = await t.run((ctx) => ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", targetId))
      .first());
    expect(settings?.allowedTiles).toContain("abonnements");
    expect(await t.run((ctx) => ctx.db.get(targetId))).not.toBeNull();
  });

  test("autorise le retrait de tuile puis la suppression sans créneau futur", async () => {
    const t = convexTest(schema, modules);
    const targetId = await createUser(t, { tiles: ["abonnements"] });
    const admin = t.withIdentity({
      subject: await createUser(t, { tiles: [], role: "admin" }),
    });
    await t.run((ctx) => ctx.db.insert("abo_test_creneaux", {
      admin_id: targetId,
      date_jour: "2020-06-02",
      heure_debut: "10:00",
      heure_fin: "10:40",
    }));

    await expect(admin.mutation(api.users.updateUserSettings, {
      userId: targetId,
      name: "Ancien encadrant",
      role: "user",
      allowedTiles: [],
      canManageAboConfiguration: false,
    })).resolves.toBeNull();
    await expect(admin.mutation(api.users.removeUser, {
      userId: targetId,
    })).resolves.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(targetId))).toBeNull();
  });
});
