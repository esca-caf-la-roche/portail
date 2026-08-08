/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("purge annuelle des comptes Abonnements", () => {
  test("conserve le compte et les droits d'un demandeur également staff", async () => {
    const t = convexTest(schema, modules);
    const { publicUserId, staffAccountId, staffSessionId, staffUserId } = await t.run(async (ctx) => {
      const publicUserId = await ctx.db.insert("users", {
        email: "public@example.test",
      });
      await ctx.db.insert("abo_profiles", {
        userId: publicUserId,
        email: "public@example.test",
        role: "utilisateur",
      });

      const staffUserId = await ctx.db.insert("users", {
        email: "staff-demandeur@example.test",
      });
      await ctx.db.insert("userSettings", {
        userId: staffUserId,
        allowedTiles: ["abonnements"],
        role: "admin",
      });
      await ctx.db.insert("abo_profiles", {
        userId: staffUserId,
        email: "staff-demandeur@example.test",
        role: "utilisateur",
      });
      const staffSessionId = await ctx.db.insert("authSessions", {
        userId: staffUserId,
        expirationTime: Date.now() + 60_000,
      });
      const staffAccountId = await ctx.db.insert("authAccounts", {
        userId: staffUserId,
        provider: "google-otp",
        providerAccountId: "staff-demandeur@example.test",
      });
      return { publicUserId, staffAccountId, staffSessionId, staffUserId };
    });

    await t.mutation(internal.abo.config.purgerComptesPublics, {});

    const state = await t.run(async (ctx) => ({
      publicUser: await ctx.db.get(publicUserId),
      staffUser: await ctx.db.get(staffUserId),
      staffSession: await ctx.db.get(staffSessionId),
      staffAccount: await ctx.db.get(staffAccountId),
      staffSettings: await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", staffUserId))
        .first(),
      staffProfile: await ctx.db
        .query("abo_profiles")
        .withIndex("by_userId", (q) => q.eq("userId", staffUserId))
        .first(),
    }));

    expect(state.publicUser).toBeNull();
    expect(state.staffUser).toMatchObject({ email: "staff-demandeur@example.test" });
    expect(state.staffSession).not.toBeNull();
    expect(state.staffAccount).toMatchObject({ provider: "google-otp" });
    expect(state.staffSettings).toMatchObject({
      allowedTiles: ["abonnements"],
      role: "admin",
    });
    expect(state.staffProfile).toBeNull();
  });

  test("progresse au-delà d'une première page composée de profils admin", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { admins, publicUserId } = await t.run(async (ctx) => {
        const admins = [];
        for (let i = 0; i < 25; i++) {
          const userId = await ctx.db.insert("users", { email: `admin-${i}@example.test` });
          await ctx.db.insert("abo_profiles", {
            userId,
            email: `admin-${i}@example.test`,
            role: "admin",
          });
          admins.push(userId);
        }
        const publicUserId = await ctx.db.insert("users", { email: "apres-admins@example.test" });
        await ctx.db.insert("abo_profiles", {
          userId: publicUserId,
          email: "apres-admins@example.test",
          role: "utilisateur",
        });
        return { admins, publicUserId };
      });

      await t.mutation(internal.abo.config.purgerComptesPublics, {});
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());

      const etat = await t.run(async (ctx) => ({
        publicUser: await ctx.db.get(publicUserId),
        admins: await Promise.all(admins.map((id) => ctx.db.get(id))),
      }));
      expect(etat.publicUser).toBeNull();
      expect(etat.admins.every(Boolean)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("liens de finalisation Abonnements", () => {
  test("accepte uniquement une URL HTTPS absolue ou une valeur vide", async () => {
    const t = convexTest(schema, modules);
    const adminId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "liens-admin@example.test" });
      await ctx.db.insert("userSettings", {
        userId,
        allowedTiles: ["abonnements"],
        role: "user",
      });
      return userId;
    });
    const admin = t.withIdentity({ subject: adminId });

    await expect(admin.mutation(api.abo.config.setLiens, {
      inscription: "http://club.example.test/inscription",
    })).rejects.toThrow("HTTPS absolue");
    await expect(admin.mutation(api.abo.config.setLiens, {
      inscription: "/inscription",
    })).rejects.toThrow("HTTPS absolue");
    await expect(admin.mutation(api.abo.config.setLiens, {
      inscription: "https://www.caflarochebonneville.fr/inscription",
    })).resolves.toBeNull();
    await expect(admin.mutation(api.abo.config.setLiens, {
      inscription: "https://club.example.test/inscription",
    })).rejects.toThrow("domaine caflarochebonneville.fr");
    await expect(admin.mutation(api.abo.config.setLiens, {
      licence_nouvelle: "https://licences.ffcam.fr/adhesion",
    })).resolves.toBeNull();
    await expect(admin.mutation(api.abo.config.setLiens, {
      inscription: "",
    })).resolves.toBeNull();
    const valeur = await t.run(async (ctx) =>
      await ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", "inscription_lien"))
        .first(),
    );
    expect(valeur?.valeur).toBeUndefined();
  });

  test("ne propose jamais un ancien lien d'inscription externe ou malformé", async () => {
    const t = convexTest(schema, modules);
    const adminId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "legacy-link-admin@example.test" });
      await ctx.db.insert("userSettings", {
        userId,
        allowedTiles: ["abonnements"],
        role: "user",
      });
      await ctx.db.insert("abo_app_config", {
        cle: "inscription_lien",
        valeur: "https://tiers.example.test/inscription",
      });
      return userId;
    });
    const admin = t.withIdentity({ subject: adminId });

    expect(await admin.query(api.abo.config.liensFinalisation, {})).toMatchObject({
      inscription: null,
    });
    expect(await admin.query(api.abo.config.getConfig, {})).toMatchObject({
      inscription_lien: "https://tiers.example.test/inscription",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", "inscription_lien"))
        .unique();
      if (row) await ctx.db.patch(row._id, { valeur: "pas une url" });
    });
    expect(await admin.query(api.abo.config.liensFinalisation, {})).toMatchObject({
      inscription: null,
    });
    expect(await admin.query(api.abo.config.getConfig, {})).toMatchObject({
      inscription_lien: "pas une url",
    });
  });
});

describe("autorisation du reset annuel Abonnements", () => {
  test("exige la tuile, le rôle admin général et l'autorisation nominative", async () => {
    const t = convexTest(schema, modules);
    const [staffSansDroit, adminSansTuile, adminAutorise] = await t.run(
      async (ctx) => {
        const create = async (settings: {
          allowedTiles: string[];
          role: string;
          canResetAboSeason: boolean;
        }) => {
          const userId = await ctx.db.insert("users", {
            email: `${crypto.randomUUID()}@example.test`,
          });
          await ctx.db.insert("userSettings", { userId, ...settings });
          return userId;
        };
        return await Promise.all([
          create({
            allowedTiles: ["abonnements"],
            role: "user",
            canResetAboSeason: false,
          }),
          create({
            allowedTiles: [],
            role: "admin",
            canResetAboSeason: true,
          }),
          create({
            allowedTiles: ["abonnements"],
            role: "admin",
            canResetAboSeason: true,
          }),
        ]);
      },
    );
    const args = {
      saisonArchivee: "2025-26",
      nouveauLien:
        "https://www.helloasso.com/associations/club-escalade/adhesions/abonnements-2026",
    };
    const redirectionId = await t.run(async (ctx) => {
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "canonique-reset@example.test", owner_id: adminAutorise,
        statut_dossier: "nouvelle_demande", date_soumission: "2026-08-08T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "RESET", prenom: "Test", nom_prenom_normalise: "RESET TEST",
        licence: "123456789012", licence_statut: "saisie", etape_demande: true,
        etape_validation: "en_attente", etape_licence: true, etape_inscription_site: false,
        etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
      });
      const fusionId = await ctx.db.insert("abo_fusions_dossiers", {
        licence_declencheur: "123456789012", mode_resolution: "conserver_b",
        dossier_a_id: dossierId, dossier_b_id: dossierId,
        owner_a_id: adminAutorise, owner_b_id: adminAutorise,
        email_a: "ancienne-reset@example.test", email_b: "canonique-reset@example.test",
        dossier_supprime_id: dossierId, personne_a_doublon_id: personneId,
        personne_b_doublon_id: personneId, personne_conservee_id: personneId,
        affectations_json: "[]", personnes_reaffectees: 0, reservations_reaffectees: 0,
        messages_reaffectes: 0, logs_reaffectes: 0, historiques_reaffectes: 0,
        compte_a: "staff_conserve", compte_b: "conserve",
        resolue_le: "2026-08-08T00:00:00.000Z", resolue_par: adminAutorise,
      });
      return await ctx.db.insert("abo_fusion_redirections_email", {
        email_supprime: "ancienne-reset@example.test", email_destination: "canonique-reset@example.test",
        dossier_destination_id: dossierId, fusion_id: fusionId, created_at: "2026-08-08T00:00:00.000Z",
      });
    });

    await expect(
      t.withIdentity({ subject: staffSansDroit }).mutation(api.abo.config.resetSaison, args),
    ).rejects.toThrow("Réinitialisation réservée");
    await expect(
      t.withIdentity({ subject: adminSansTuile }).mutation(api.abo.config.resetSaison, args),
    ).rejects.toThrow("Réservé aux administrateurs");
    await expect(
      t.withIdentity({ subject: adminAutorise }).mutation(api.abo.config.resetSaison, args),
    ).resolves.toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(redirectionId))).toBeNull();
  });
});
