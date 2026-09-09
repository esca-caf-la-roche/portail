/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { REGLEMENT_VERSION } from "./abo/reglementsConstants";

const modules = import.meta.glob("./**/*.ts");
const MAINTENANT_MS = Date.parse("2026-09-09T08:00:00.000Z");

async function preparerFixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { email: "staff-abo@example.test" });
    await ctx.db.insert("userSettings", {
      userId: staffId,
      role: "user",
      allowedTiles: ["abonnements"],
    });
    const adminGlobalId = await ctx.db.insert("users", { email: "admin-global@example.test" });
    await ctx.db.insert("userSettings", {
      userId: adminGlobalId,
      role: "admin",
      allowedTiles: [],
    });
    const abonneId = await ctx.db.insert("users", { email: "abonne@example.test" });
    await ctx.db.insert("abo_profiles", {
      userId: abonneId,
      email: "abonne@example.test",
      role: "utilisateur",
    });
    const dossierId = await ctx.db.insert("abo_dossiers", {
      email: "abonne@example.test",
      owner_id: abonneId,
      statut_dossier: "validee",
      date_soumission: "2026-09-01T08:00:00.000Z",
      commentaire: "Dossier familial",
    });
    const personneId = await ctx.db.insert("abo_personnes", {
      dossier_id: dossierId,
      nom: "DUPONT",
      prenom: "Alice",
      nom_prenom_normalise: "DUPONT ALICE",
      age: 30,
      licence: "748012345678",
      licence_statut: "annuaire_valide",
      etape_demande: true,
      etape_validation: "validee",
      etape_licence: true,
      etape_test_autonomie: "requis",
      etape_inscription_site: false,
      etape_photo: false,
      etape_paiement: false,
      etape_abonnement_valide: false,
      vague_depot: "vague_3",
      deposee_le: "2026-09-01T08:00:00.000Z",
    });
    await ctx.db.insert("abo_licences", {
      licence: "748012345678",
      nom: "DUPONT",
      prenom: "Alice",
      nom_prenom_normalise: "DUPONT ALICE",
      imported_at: "2026-09-02T08:00:00.000Z",
    });
    await ctx.db.insert("abo_abonnes_scrap", {
      licence: "748012345678",
      nom: "DUPONT",
      prenom: "Alice",
      nom_prenom_normalise: "DUPONT ALICE",
      age: 31,
      adhesion: "OK",
      autonomie: "Doit passer le test",
      abonnement_valide: "oui",
    });
    await ctx.db.insert("abo_reglements_signes", {
      drive_file_id: "drive-reglement",
      drive_file_name: "reglement.pdf",
      drive_url: "https://drive.example.test/reglement",
      version_reglement: REGLEMENT_VERSION,
      nom: "DUPONT",
      prenom: "Alice",
      nom_prenom_normalise: "DUPONT ALICE",
      licence: "748012345678",
      liaison_validee_par: staffId,
      liaison_validee_le: "2026-09-02T08:00:00.000Z",
      statut_site: "enregistre",
    });
    await ctx.db.insert("abo_test_reservations", {
      personne_id: personneId,
      tranche: "2026-09-20T08:00:00.000Z",
      tranche_fin: "2026-09-20T09:00:00.000Z",
      statut: "annulee",
      annulee_le: "2026-09-03T08:00:00.000Z",
      annulee_raison: "creneau_admin_annule",
    });
    const reservationId = await ctx.db.insert("abo_test_reservations", {
      personne_id: personneId,
      tranche: "2026-09-27T08:00:00.000Z",
      tranche_fin: "2026-09-27T09:00:00.000Z",
      statut: "active",
      etat_confirmation: "confirmee",
    });
    await ctx.db.insert("abo_test_attentes_notifications", {
      user_id: abonneId,
      type_candidat: "dossier",
      personne_id: personneId,
      cle_candidat: `dossier:${personneId}`,
      statut: "en_attente",
      cree_le: 1,
      modifie_le: 1,
    });
    const messageAbonneId = await ctx.db.insert("abo_messages", {
      dossier_id: dossierId,
      auteur_id: abonneId,
      auteur_role: "utilisateur",
      contenu: "Mon message",
      lu_par_admin: false,
      lu_par_user: true,
    });
    const messageAdminId = await ctx.db.insert("abo_messages", {
      dossier_id: dossierId,
      auteur_id: staffId,
      auteur_role: "admin",
      contenu: "Réponse de la commission",
      lu_par_admin: true,
      lu_par_user: false,
    });
    await ctx.db.insert("abo_app_config", {
      cle: "licence_lien_nouvelle",
      valeur: "https://licences.example.test/nouvelle",
    });
    await ctx.db.insert("abo_app_config", {
      cle: "vague3_debut",
      valeur: "2026-09-09T09:00",
    });
    return {
      staffId,
      adminGlobalId,
      abonneId,
      dossierId,
      personneId,
      reservationId,
      messageAbonneId,
      messageAdminId,
    };
  });
  return { t, ...ids };
}

describe("prévisualisation admin comme l'abonné", () => {
  test("autorise le staff Abonnements et projette le suivi sans aucune écriture", async () => {
    const fixture = await preparerFixture();
    const avant = await fixture.t.run(async (ctx) => ({
      messages: await ctx.db
        .query("abo_messages")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect(),
      emails: await ctx.db
        .query("abo_email_log")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect(),
      sessions: await ctx.db.query("authSessions").collect(),
      reservations: await ctx.db
        .query("abo_test_reservations")
        .withIndex("by_personne", (q) => q.eq("personne_id", fixture.personneId))
        .collect(),
    }));

    const apercu = await fixture.t
      .withIdentity({ subject: fixture.staffId })
      .query(api.abo.apercu.get, {
        dossierId: fixture.dossierId,
        maintenantMs: MAINTENANT_MS,
      });

    expect(apercu).toMatchObject({
      lectureSeule: true,
      vague: 3,
      dossier: {
        id: fixture.dossierId,
        email: "abonne@example.test",
        statut_dossier: "validee",
        commentaire: "Dossier familial",
        personnes: [{ id: fixture.personneId, nom: "DUPONT", prenom: "Alice" }],
      },
      checks: [{
        personne_id: fixture.personneId,
        licence_ok: true,
        inscription_ok: true,
        paiement_ok: true,
        test_autonomie: "requis",
        reglement_signe: true,
        age: 31,
      }],
      reservations: [{
        personne_id: fixture.personneId,
        active: { id: fixture.reservationId, etat_confirmation: "confirmee" },
        annulee: { annulee_raison: "creneau_admin_annule" },
      }],
      suivisDisponibilites: [{
        cle: `dossier:${fixture.personneId}`,
        statut: "en_attente",
      }],
      liens: { licence_nouvelle: "https://licences.example.test/nouvelle" },
      messagesTronques: false,
    });
    expect(apercu.messages).toEqual([
      expect.objectContaining({
        id: fixture.messageAbonneId,
        auteur_role: "utilisateur",
        est_moi: true,
        lu_par_admin: false,
        lu_par_user: true,
      }),
      expect.objectContaining({
        id: fixture.messageAdminId,
        auteur_role: "admin",
        est_moi: false,
        lu_par_admin: true,
        lu_par_user: false,
      }),
    ]);

    const apres = await fixture.t.run(async (ctx) => ({
      messages: await ctx.db
        .query("abo_messages")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect(),
      emails: await ctx.db
        .query("abo_email_log")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect(),
      sessions: await ctx.db.query("authSessions").collect(),
      reservations: await ctx.db
        .query("abo_test_reservations")
        .withIndex("by_personne", (q) => q.eq("personne_id", fixture.personneId))
        .collect(),
    }));
    expect(apres).toEqual(avant);
  });

  test("refuse un administrateur global sans tuile Abonnements", async () => {
    const fixture = await preparerFixture();
    await expect(
      fixture.t
        .withIdentity({ subject: fixture.adminGlobalId })
        .query(api.abo.apercu.get, {
          dossierId: fixture.dossierId,
          maintenantMs: MAINTENANT_MS,
        }),
    ).rejects.toThrow("Réservé aux administrateurs");
  });

  test("refuse un abonné, y compris pour son propre dossier", async () => {
    const fixture = await preparerFixture();
    await expect(
      fixture.t
        .withIdentity({ subject: fixture.abonneId })
        .query(api.abo.apercu.get, {
          dossierId: fixture.dossierId,
          maintenantMs: MAINTENANT_MS,
        }),
    ).rejects.toThrow("Réservé aux administrateurs");
  });

  test("signale proprement un dossier absent au staff autorisé", async () => {
    const fixture = await preparerFixture();
    await fixture.t.run(async (ctx) => {
      const messages = await ctx.db
        .query("abo_messages")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect();
      for (const message of messages) await ctx.db.delete(message._id);
      const personnes = await ctx.db
        .query("abo_personnes")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", fixture.dossierId))
        .collect();
      for (const personne of personnes) await ctx.db.delete(personne._id);
      await ctx.db.delete(fixture.dossierId);
    });

    await expect(
      fixture.t
        .withIdentity({ subject: fixture.staffId })
        .query(api.abo.apercu.get, {
          dossierId: fixture.dossierId,
          maintenantMs: MAINTENANT_MS,
        }),
    ).rejects.toThrow("ABO_APERCU_DOSSIER_INTROUVABLE");
  });
});
