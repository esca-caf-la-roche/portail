/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function creerAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "admin@example.test" });
    await ctx.db.insert("userSettings", { userId: id, allowedTiles: ["abonnements"], role: "admin" });
    return id;
  });
  return t.withIdentity({ subject: userId });
}

async function creerDossier(t: ReturnType<typeof convexTest>, email: string, licence?: string, staff = false) {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { email });
    await ctx.db.insert("abo_profiles", { userId: ownerId, email, role: "utilisateur" });
    if (staff) await ctx.db.insert("userSettings", { userId: ownerId, allowedTiles: [], role: "user" });
    const dossierId = await ctx.db.insert("abo_dossiers", {
      email,
      owner_id: ownerId,
      statut_dossier: "nouvelle_demande",
      date_soumission: "2026-08-08T00:00:00.000Z",
    });
    const personneId = await ctx.db.insert("abo_personnes", {
      dossier_id: dossierId,
      nom: "DUPONT",
      prenom: email.split("@")[0],
      nom_prenom_normalise: `DUPONT ${email.split("@")[0].toUpperCase()}`,
      licence,
      licence_statut: licence ? "saisie" : "inconnu",
      etape_demande: true,
      etape_validation: "en_attente",
      etape_licence: Boolean(licence),
      etape_inscription_site: false,
      etape_photo: false,
      etape_paiement: false,
      etape_abonnement_valide: false,
    });
    return { ownerId, dossierId, personneId };
  });
}

async function ajouterPersonne(
  t: ReturnType<typeof convexTest>,
  dossierId: Id<"abo_dossiers">,
  prenom: string,
) {
  return await t.run(async (ctx) => ctx.db.insert("abo_personnes", {
    dossier_id: dossierId,
    nom: "FAMILLE",
    prenom,
    nom_prenom_normalise: `FAMILLE ${prenom.toUpperCase()}`,
    licence_statut: "inconnu",
    etape_demande: true,
    etape_validation: "validee",
    etape_licence: false,
    etape_inscription_site: false,
    etape_photo: false,
    etape_paiement: false,
    etape_abonnement_valide: false,
  }));
}

describe("résolution simple d'un conflit de licence entre dossiers", () => {
  test("validerLicence signale le conflit sans écrire la licence sur la cible", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    await expect(admin.mutation(api.abo.licences.validerLicence, {
      personneId: b.personneId,
      licence: "123456789012",
    })).resolves.toMatchObject({
      statut: "conflit",
      personneExistanteId: a.personneId,
      personneCibleDossierId: b.dossierId,
    });
    expect((await t.run(async ctx => ctx.db.get(b.personneId)))?.licence).toBeUndefined();
  });

  test("garde les deux dossiers, échange des personnes et ne conserve qu'une fiche licenciée", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    const enfantA = await ajouterPersonne(t, a.dossierId, "Enfant A");
    const enfantB = await ajouterPersonne(t, b.dossierId, "Enfant B");
    const messageA = await t.run(async ctx => ctx.db.insert("abo_messages", {
      dossier_id: a.dossierId, auteur_id: a.ownerId, auteur_role: "utilisateur",
      contenu: "reste dans A", lu_par_admin: false, lu_par_user: true,
    }));
    await t.run(async ctx => ctx.db.insert("abo_abonnes_scrap", {
      licence: "123456789012",
      nom: "DUPONT",
      prenom: "Actualisé",
      nom_prenom_normalise: "DUPONT ACTUALISE",
      age: 42,
      adhesion: "OK",
      autonomie: "OK",
      photo: "OK",
      abonnement_valide: "oui",
    }));

    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    expect(apercu.dossierA).toMatchObject({ email: "a@example.test", personnes: [{ id: enfantA }] });
    expect(apercu.dossierB).toMatchObject({ email: "b@example.test", personnes: [{ id: enfantB }] });
    expect(apercu.personneDoublon).toMatchObject({
      idLogique: a.personneId,
      optionA: { id: a.personneId, licence: "123456789012" },
      optionB: { id: b.personneId, licence: null },
    });

    const resultat = await admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId,
      personneBId: b.personneId,
      revision: apercu.revision,
      mode: "conserver_les_deux",
      affectations: [
        { personneId: a.personneId, dossierId: b.dossierId },
        { personneId: enfantA, dossierId: b.dossierId },
        { personneId: enfantB, dossierId: a.dossierId },
      ],
    });
    expect(resultat).toMatchObject({
      mode: "conserver_les_deux", dossierSupprimeId: null,
      personneDoublonConserveeId: b.personneId, personnesDeplacees: 2,
      messagesReaffectes: 0, compteA: "conserve", compteB: "conserve",
    });
    const etat = await t.run(async ctx => ({
      dossierA: await ctx.db.get(a.dossierId),
      dossierB: await ctx.db.get(b.dossierId),
      ficheA: await ctx.db.get(a.personneId),
      ficheB: await ctx.db.get(b.personneId),
      enfantA: await ctx.db.get(enfantA),
      enfantB: await ctx.db.get(enfantB),
      porteurs: await ctx.db.query("abo_personnes").withIndex("by_licence", q => q.eq("licence", "123456789012")).collect(),
      messageA: await ctx.db.get(messageA),
      redirections: await ctx.db.query("abo_fusion_redirections_email").collect(),
      notifications: await ctx.db.query("abo_fusion_notifications")
        .withIndex("by_fusion_id", q => q.eq("fusion_id", resultat.resolutionId)).collect(),
    }));
    expect(etat.dossierA).not.toBeNull();
    expect(etat.dossierB).not.toBeNull();
    expect(etat.ficheA).toBeNull();
    expect(etat.ficheB).toMatchObject({
      dossier_id: b.dossierId,
      licence: "123456789012",
      age: 42,
      etape_licence: true,
      etape_inscription_site: true,
      etape_photo: true,
      etape_abonnement_valide: true,
      etape_test_autonomie: "valide",
    });
    expect(etat.enfantA?.dossier_id).toBe(b.dossierId);
    expect(etat.enfantB?.dossier_id).toBe(a.dossierId);
    expect(etat.porteurs).toHaveLength(1);
    expect(etat.messageA?.dossier_id).toBe(a.dossierId);
    expect(etat.redirections).toHaveLength(0);
    expect(etat.notifications).toHaveLength(2);
    expect(etat.notifications.map(n => n.destinataire)).toEqual(["a@example.test", "b@example.test"]);
    expect(etat.notifications[0]?.contenu).toContain("Dossier a@example.test");
    expect(etat.notifications[0]?.contenu).not.toContain("b@example.test");
    expect(etat.notifications[1]?.contenu).toContain("Dossier b@example.test");
    expect(etat.notifications[1]?.contenu).not.toContain("a@example.test");
    await t.mutation(internal.abo.fusionsDossiers.terminerNotificationFusion, {
      notificationId: etat.notifications[0]!._id,
      succes: true,
    });
    expect((await t.run(async ctx => ctx.db.get(etat.notifications[0]!._id)))?.statut).toBe("envoye");
  });

  test("garde A et transfère les dépendances, la redirection et l'auth du dossier B supprimé", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    const enfantB = await ajouterPersonne(t, b.dossierId, "Enfant B");
    const ids = await t.run(async ctx => {
      const message = await ctx.db.insert("abo_messages", {
        dossier_id: b.dossierId, auteur_id: b.ownerId, auteur_role: "utilisateur",
        contenu: "historique", lu_par_admin: false, lu_par_user: true,
      });
      const log = await ctx.db.insert("abo_email_log", {
        dossier_id: b.dossierId, type_email: "accuse", destinataire: b.ownerId,
        sent_at: "2026-08-08T00:00:00.000Z",
      });
      const historique = await ctx.db.insert("abo_demandes_supprimees", {
        email: "b@example.test", owner_id: b.ownerId, supprime_le: "2026-01-01T00:00:00.000Z",
      });
      const compte = await ctx.db.insert("authAccounts", {
        userId: b.ownerId, provider: "abo-otp", providerAccountId: "b@example.test",
      });
      return { message, log, historique, compte };
    });
    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    const resultat = await admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId, personneBId: b.personneId, revision: apercu.revision,
      mode: "conserver_a",
      affectations: [
        { personneId: a.personneId, dossierId: a.dossierId },
        { personneId: enfantB, dossierId: a.dossierId },
      ],
    });
    expect(resultat).toMatchObject({
      dossierSupprimeId: b.dossierId, personneDoublonConserveeId: a.personneId,
      messagesReaffectes: 1, logsReaffectes: 1, historiquesReaffectes: 1,
      compteA: "conserve", compteB: "desactive", notificationsPlanifiees: 2,
    });
    const etat = await t.run(async ctx => ({
      dossierB: await ctx.db.get(b.dossierId),
      enfantB: await ctx.db.get(enfantB),
      message: await ctx.db.get(ids.message),
      log: await ctx.db.get(ids.log),
      historique: await ctx.db.get(ids.historique),
      compte: await ctx.db.get(ids.compte),
      profileB: await ctx.db.query("abo_profiles").withIndex("by_userId", q => q.eq("userId", b.ownerId)).first(),
      redirection: await ctx.db.query("abo_fusion_redirections_email")
        .withIndex("by_email_supprime", q => q.eq("email_supprime", "b@example.test")).unique(),
      notifications: await ctx.db.query("abo_fusion_notifications")
        .withIndex("by_fusion_id", q => q.eq("fusion_id", resultat.resolutionId)).collect(),
    }));
    expect(etat.dossierB).toBeNull();
    expect(etat.enfantB?.dossier_id).toBe(a.dossierId);
    expect(etat.message?.dossier_id).toBe(a.dossierId);
    expect(etat.log?.dossier_id).toBe(a.dossierId);
    expect(etat.historique?.owner_id).toBe(a.ownerId);
    expect(etat.compte).toBeNull();
    expect(etat.profileB).toBeNull();
    expect(etat.redirection).toMatchObject({ email_destination: "a@example.test", dossier_destination_id: a.dossierId });
    expect(etat.notifications).toHaveLength(2);
    expect(etat.notifications.map(n => n.destinataire)).toEqual(["a@example.test", "b@example.test"]);
    expect(etat.notifications[0]?.contenu).not.toContain("b@example.test");
    expect(etat.notifications[1]?.contenu).toContain("accessible par a@example.test");
    expect(etat.notifications[1]?.contenu).not.toContain("Dossier b@example.test");
  });

  test("garde B et conserve physiquement la fiche B", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    const resultat = await admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId, personneBId: b.personneId, revision: apercu.revision,
      mode: "conserver_b",
      affectations: [{ personneId: a.personneId, dossierId: b.dossierId }],
    });
    expect(resultat.personneDoublonConserveeId).toBe(b.personneId);
    const etat = await t.run(async ctx => ({
      porteurs: await ctx.db.query("abo_personnes")
        .withIndex("by_licence", q => q.eq("licence", "123456789012")).collect(),
      notifications: await ctx.db.query("abo_fusion_notifications")
        .withIndex("by_fusion_id", q => q.eq("fusion_id", resultat.resolutionId)).collect(),
    }));
    expect(etat.porteurs).toMatchObject([{ _id: b.personneId, dossier_id: b.dossierId }]);
    expect(etat.notifications).toHaveLength(2);
    expect(etat.notifications.map(n => n.destinataire)).toEqual(["a@example.test", "b@example.test"]);
    expect(etat.notifications[0]?.contenu).toContain("accessible par b@example.test");
    expect(etat.notifications[1]?.contenu).not.toContain("a@example.test");
  });

  test("refuse une affectation manquante, un dossier supprimé et un dossier conservé vide", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    const enfantA = await ajouterPersonne(t, a.dossierId, "Enfant A");
    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    const base = { personneAId: a.personneId, personneBId: b.personneId, revision: apercu.revision };
    await expect(admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      ...base, mode: "conserver_a", affectations: [{ personneId: a.personneId, dossierId: a.dossierId }],
    })).rejects.toThrow("Chaque personne doit être reliée");
    await expect(admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      ...base, mode: "conserver_a", affectations: [
        { personneId: a.personneId, dossierId: b.dossierId },
        { personneId: enfantA, dossierId: a.dossierId },
      ],
    })).rejects.toThrow("dossier supprimé");
    await expect(admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      ...base, mode: "conserver_les_deux", affectations: [
        { personneId: a.personneId, dossierId: a.dossierId },
        { personneId: enfantA, dossierId: a.dossierId },
      ],
    })).rejects.toThrow("Chaque dossier conservé");
  });

  test("refuse deux réservations actives sans supprimer de fiche", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test");
    await t.run(async ctx => {
      await ctx.db.insert("abo_test_reservations", { personne_id: a.personneId, tranche: "2026-08-10T10:00:00.000Z", statut: "active" });
      await ctx.db.insert("abo_test_reservations", { personne_id: b.personneId, tranche: "2026-08-11T10:00:00.000Z", statut: "active" });
    });
    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    expect(apercu.alertes).toMatchObject([{ code: "DOUBLE_RESERVATION_ACTIVE" }]);
    await expect(admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId, personneBId: b.personneId, revision: apercu.revision,
      mode: "conserver_a", affectations: [{ personneId: a.personneId, dossierId: a.dossierId }],
    })).rejects.toThrow("deux fiches du doublon ont une réservation active");
    expect(await t.run(async ctx => ctx.db.get(b.personneId))).not.toBeNull();
  });

  test("exige un admin Abonnements et refuse une révision obsolète", async () => {
    const t = convexTest(schema, modules);
    const admin = await creerAdmin(t);
    const a = await creerDossier(t, "a@example.test", "123456789012");
    const b = await creerDossier(t, "b@example.test", undefined, true);
    const historiqueStaff = await t.run(async ctx => ctx.db.insert("abo_demandes_supprimees", {
      email: "b@example.test", owner_id: b.ownerId, supprime_le: "2026-01-01T00:00:00.000Z",
    }));
    const publicUser = t.withIdentity({ subject: a.ownerId });
    await expect(publicUser.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    })).rejects.toThrow();
    const apercu = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    await t.run(async ctx => ctx.db.patch(b.personneId, { etape_photo: true }));
    await expect(admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId, personneBId: b.personneId, revision: apercu.revision,
      mode: "conserver_a", affectations: [{ personneId: a.personneId, dossierId: a.dossierId }],
    })).rejects.toThrow("ont changé depuis l'aperçu");

    const frais = await admin.query(api.abo.fusionsDossiers.getApercuRepartitionDossiers, {
      personneAId: a.personneId, personneBId: b.personneId,
    });
    const resultat = await admin.mutation(api.abo.fusionsDossiers.resoudreConflitDossiers, {
      personneAId: a.personneId, personneBId: b.personneId, revision: frais.revision,
      mode: "conserver_a", affectations: [{ personneId: a.personneId, dossierId: a.dossierId }],
    });
    expect(resultat.compteB).toBe("staff_conserve");
    expect(resultat.historiquesReaffectes).toBe(0);
    const staff = await t.run(async ctx => ({
      user: await ctx.db.get(b.ownerId),
      settings: await ctx.db.query("userSettings").withIndex("by_userId", q => q.eq("userId", b.ownerId)).first(),
      profile: await ctx.db.query("abo_profiles").withIndex("by_userId", q => q.eq("userId", b.ownerId)).first(),
      historique: await ctx.db.get(historiqueStaff),
    }));
    expect(staff.user).not.toBeNull();
    expect(staff.settings).not.toBeNull();
    expect(staff.profile).toBeNull();
    expect(staff.historique?.owner_id).toBe(b.ownerId);
  });

  test("canonise l'email de session avant de reconnaître une redirection", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async ctx => {
      const id = await ctx.db.insert("users", { email: "  ANCIENNE@EXAMPLE.TEST  " });
      await ctx.db.insert("abo_profiles", { userId: id, email: "ancienne@example.test", role: "utilisateur" });
      const destinationOwner = await ctx.db.insert("users", { email: "destination@example.test" });
      const destination = await ctx.db.insert("abo_dossiers", {
        email: "destination@example.test", owner_id: destinationOwner,
        statut_dossier: "nouvelle_demande", date_soumission: "2026-08-08T00:00:00.000Z",
      });
      const personne = await ctx.db.insert("abo_personnes", {
        dossier_id: destination, nom: "TEST", prenom: "Destination", nom_prenom_normalise: "TEST DESTINATION",
        licence: "123456789012", licence_statut: "saisie", etape_demande: true,
        etape_validation: "en_attente", etape_licence: true, etape_inscription_site: false,
        etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
      });
      const fusion = await ctx.db.insert("abo_fusions_dossiers", {
        licence_declencheur: "123456789012", mode_resolution: "conserver_b",
        dossier_a_id: destination, dossier_b_id: destination, owner_a_id: id, owner_b_id: destinationOwner,
        email_a: "ancienne@example.test", email_b: "destination@example.test",
        dossier_supprime_id: destination, personne_a_doublon_id: personne,
        personne_b_doublon_id: personne, personne_conservee_id: personne, affectations_json: "[]",
        personnes_reaffectees: 0, reservations_reaffectees: 0, messages_reaffectes: 0,
        logs_reaffectes: 0, historiques_reaffectes: 0, compte_a: "desactive", compte_b: "conserve",
        resolue_le: "2026-08-08T00:00:00.000Z", resolue_par: destinationOwner,
      });
      await ctx.db.insert("abo_fusion_redirections_email", {
        email_supprime: "ancienne@example.test", email_destination: "destination@example.test",
        dossier_destination_id: destination, fusion_id: fusion, created_at: "2026-08-08T00:00:00.000Z",
      });
      return id;
    });
    await expect(t.withIdentity({ subject: userId }).mutation(internal.abo.demandes.creerDemandeInterne, {
      personnes: [{ nom: "TEST", prenom: "Ancienne" }],
    })).rejects.toThrow("Ce compte a été regroupé");
  });
});
