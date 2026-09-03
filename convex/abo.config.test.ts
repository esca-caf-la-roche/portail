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
        canManageAboConfiguration: true,
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
        canManageAboConfiguration: true,
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
  test("la bascule des synchronisations est active par défaut et réservée au staff Abonnements", async () => {
    const t = convexTest(schema, modules);
    const { adminId, publicId } = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert("users", { email: "sync-admin@example.test" });
      await ctx.db.insert("userSettings", {
        userId: adminId,
        allowedTiles: ["abonnements"],
        role: "user",
        canManageAboConfiguration: true,
      });
      const publicId = await ctx.db.insert("users", { email: "sync-public@example.test" });
      await ctx.db.insert("abo_profiles", {
        userId: publicId,
        email: "sync-public@example.test",
        role: "utilisateur",
      });
      return { adminId, publicId };
    });

    const admin = t.withIdentity({ subject: adminId });
    expect(await admin.query(api.abo.config.getConfig, {})).toMatchObject({
      synchronisation_externe_active: true,
    });
    await expect(admin.mutation(api.abo.config.setSynchronisationExterneActive, { active: false }))
      .resolves.toBe(false);
    expect(await admin.query(api.abo.config.getConfig, {})).toMatchObject({
      synchronisation_externe_active: false,
    });
    await expect(
      t.withIdentity({ subject: publicId }).mutation(api.abo.config.setSynchronisationExterneActive, { active: true }),
    ).rejects.toThrow("ABO_CONFIGURATION_ACCES_REFUSE");
  });

  test("exige la tuile, le rôle admin général et l'autorisation nominative", async () => {
    const t = convexTest(schema, modules);
    const [staffSansDroit, adminSansTuile, adminAutorise] = await t.run(
      async (ctx) => {
        const create = async (settings: {
          allowedTiles: string[];
          role: string;
          canManageAboConfiguration: boolean;
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
            canManageAboConfiguration: false,
          }),
          create({
            allowedTiles: [],
            role: "admin",
            canManageAboConfiguration: true,
          }),
          create({
            allowedTiles: ["abonnements"],
            role: "user",
            canManageAboConfiguration: true,
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
      await ctx.db.insert("abo_licences_cours_traitements", {
        cle_identite: '["nom_date_naissance","RESET TEST","2010-01-01"]',
        traite_at: "2026-08-08T00:00:00.000Z",
        traite_par: adminAutorise,
      });
      for (const cle of [
        "last_sync_helloasso",
        "last_sync_scrap",
        "last_sync_eleves",
        "last_manual_sync_paiements_abo",
        "last_sync_annuaire",
        "last_attempt_sync_annuaire",
      ]) {
        await ctx.db.insert("abo_app_config", {
          cle,
          valeur: "2026-08-08T00:00:00.000Z",
        });
      }
      return await ctx.db.insert("abo_fusion_redirections_email", {
        email_supprime: "ancienne-reset@example.test", email_destination: "canonique-reset@example.test",
        dossier_destination_id: dossierId, fusion_id: fusionId, created_at: "2026-08-08T00:00:00.000Z",
      });
    });

    await expect(
      t.withIdentity({ subject: staffSansDroit }).mutation(api.abo.config.resetSaison, args),
    ).rejects.toThrow("ABO_CONFIGURATION_ACCES_REFUSE");
    await expect(
      t.withIdentity({ subject: adminSansTuile }).mutation(api.abo.config.resetSaison, args),
    ).rejects.toThrow("ABO_CONFIGURATION_ACCES_REFUSE");
    vi.useFakeTimers();
    try {
      await expect(
        t.withIdentity({ subject: adminAutorise }).mutation(api.abo.config.resetSaison, args),
      ).resolves.toBe(0);
      await expect(
        t.withIdentity({ subject: adminAutorise }).mutation(
          api.abo.config.setSynchronisationExterneActive,
          { active: true },
        ),
      ).rejects.toThrow("purge des suivis de la campagne précédente est encore en cours");
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    } finally {
      vi.useRealTimers();
    }
    expect(await t.run(async (ctx) => ctx.db.get(redirectionId))).toBeNull();
    expect(await t.run(async (ctx) =>
      ctx.db.query("abo_licences_cours_traitements").collect(),
    )).toEqual([]);
    expect(await t.run(async (ctx) =>
      ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", "synchronisation_externe_active"))
        .unique(),
    )).toMatchObject({ valeur: "false" });
    const marqueurPurge = await t.run(async (ctx) =>
      ctx.db.query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", "purge_suivi_campagne_active"))
        .unique(),
    );
    expect(marqueurPurge?.valeur).toBeUndefined();
    const marqueursSync = await t.run(async (ctx) => {
      const lire = async (cle: string) => await ctx.db
        .query("abo_app_config")
        .withIndex("by_cle", (q) => q.eq("cle", cle))
        .unique();
      return {
        helloasso: await lire("last_sync_helloasso"),
        scrap: await lire("last_sync_scrap"),
        eleves: await lire("last_sync_eleves"),
        verrouPaiements: await lire("last_manual_sync_paiements_abo"),
        annuaire: await lire("last_sync_annuaire"),
        tentativeAnnuaire: await lire("last_attempt_sync_annuaire"),
      };
    });
    expect(marqueursSync).toMatchObject({
      helloasso: null,
      scrap: null,
      eleves: null,
      verrouPaiements: null,
      annuaire: { valeur: "2026-08-08T00:00:00.000Z" },
      tentativeAnnuaire: { valeur: "2026-08-08T00:00:00.000Z" },
    });
  });

  test("refuse l'import des élèves tant que le site club n'a pas basculé", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", {
        cle: "synchronisation_externe_active",
        valeur: "false",
      });
    });

    await expect(
      t.action(internal.abo.scrap.importerElevesEnCours, { contexteAbo: true }),
    ).rejects.toThrow("synchronisation des élèves Abonnements est désactivée");
  });

  test("purge par lots les suivis de campagne sans toucher aux références conservées", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", { email: "purge-suivi@example.test" });
        const dossierId = await ctx.db.insert("abo_dossiers", {
          email: "purge-suivi@example.test", owner_id: userId,
          statut_dossier: "nouvelle_demande", date_soumission: "2026-08-08T00:00:00.000Z",
        });
        const personneId = await ctx.db.insert("abo_personnes", {
          dossier_id: dossierId, nom: "PURGE", prenom: "Suivi", nom_prenom_normalise: "PURGE SUIVI",
          licence: "123456789012", licence_statut: "saisie", etape_demande: true,
          etape_validation: "en_attente", etape_licence: true, etape_inscription_site: false,
          etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
        });
        const fusionId = await ctx.db.insert("abo_fusions_dossiers", {
          licence_declencheur: "123456789012", mode_resolution: "conserver_b",
          dossier_a_id: dossierId, dossier_b_id: dossierId, owner_a_id: userId, owner_b_id: userId,
          email_a: "a@example.test", email_b: "b@example.test", dossier_supprime_id: dossierId,
          personne_a_doublon_id: personneId, personne_b_doublon_id: personneId,
          personne_conservee_id: personneId, affectations_json: "[]", personnes_reaffectees: 0,
          reservations_reaffectees: 0, messages_reaffectes: 0, logs_reaffectes: 0,
          historiques_reaffectes: 0, compte_a: "conserve", compte_b: "conserve",
          resolue_le: "2026-08-08T00:00:00.000Z", resolue_par: userId,
        });
        await ctx.db.insert("abo_tests_autonomie_archive", {
          licence: "123456789012", nom: "PURGE", prenom: "Suivi", nom_prenom_normalise: "PURGE SUIVI",
          drive_file_id: "drive-test", drive_url: "https://drive.example.test/test", statut: "a_traiter",
        });
        const archiveId = await ctx.db.insert("abo_tests_autonomie_archive", {
          licence: "123456789013", nom: "PURGE", prenom: "Ticket", nom_prenom_normalise: "PURGE TICKET",
          drive_file_id: "", drive_url: "", statut: "a_traiter",
        });
        await ctx.db.insert("abo_test_document_uploads", {
          archive_id: archiveId, author_id: userId, token: "token", statut: "autorise", expires_at: Date.now() + 60_000,
        });
        await ctx.db.insert("abo_reglements_signes", {
          drive_file_id: "drive-reglement", drive_file_name: "reglement.pdf", drive_url: "https://drive.example.test/reglement",
          version_reglement: "2026", nom: "PURGE", prenom: "Suivi", nom_prenom_normalise: "PURGE SUIVI",
          licence: "123456789012", liaison_validee_par: userId, liaison_validee_le: "2026-08-08T00:00:00.000Z",
          statut_site: "a_enregistrer",
        });
        await ctx.db.insert("abo_reglements_imports", {
          version_reglement: "2026", statut: "a_rapprocher", importe_le: "2026-08-08T00:00:00.000Z",
        });
        await ctx.db.insert("abo_fusion_notifications", {
          fusion_id: fusionId, destinataire: "a@example.test", role_destinataire: "dossier_a",
          sujet: "Fusion", contenu: "Contenu", statut: "a_envoyer", tentatives: 0,
        });
        await ctx.db.insert("abo_fusion_redirections_email", {
          email_supprime: "a@example.test", email_destination: "b@example.test", dossier_destination_id: dossierId,
          fusion_id: fusionId, created_at: "2026-08-08T00:00:00.000Z",
        });
        await ctx.db.insert("abo_licence_fusions", {
          licence: "123456789012", personne_source_id: personneId, personne_cible_id: personneId,
          dossier_source_id: dossierId, dossier_cible_id: dossierId, source_nom: "PURGE", source_prenom: "Suivi",
          fusionnee_le: "2026-08-08T00:00:00.000Z", fusionnee_par: userId,
        });
        await ctx.db.insert("abo_abonnes_archive", {
          licence: "123456789012", nom: "GARDER", prenom: "N-1", nom_prenom_normalise: "GARDER N-1",
          abonnement_valide: true, saison: "2025-26",
        });
        await ctx.db.insert("abo_licences", {
          licence: "123456789012", nom: "GARDER", prenom: "ANNUAIRE", nom_prenom_normalise: "GARDER ANNUAIRE",
          imported_at: "2026-08-08T00:00:00.000Z",
        });
      });

      await t.mutation(internal.abo.config.purgerSuiviCampagne, { etape: "uploads_tests" });
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const compte = await t.run(async (ctx) => ({
        uploads: await ctx.db.query("abo_test_document_uploads").collect(),
        archives: await ctx.db.query("abo_tests_autonomie_archive").collect(),
        imports: await ctx.db.query("abo_reglements_imports").collect(),
        reglements: await ctx.db.query("abo_reglements_signes").collect(),
        notifications: await ctx.db.query("abo_fusion_notifications").collect(),
        redirections: await ctx.db.query("abo_fusion_redirections_email").collect(),
        fusionsDossiers: await ctx.db.query("abo_fusions_dossiers").collect(),
        fusionsLicences: await ctx.db.query("abo_licence_fusions").collect(),
        archiveN1: await ctx.db.query("abo_abonnes_archive").collect(),
        licences: await ctx.db.query("abo_licences").collect(),
      }));
      expect(compte).toMatchObject({
        uploads: [], archives: [], imports: [], reglements: [], notifications: [], redirections: [],
        fusionsDossiers: [], fusionsLicences: [],
      });
      expect(compte.archiveN1).toHaveLength(1);
      expect(compte.licences).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
