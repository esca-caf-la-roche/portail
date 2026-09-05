/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const creerTest = () => convexTest(schema, modules);
const ligne = { licence: "123456789012", nom: "DUPONT", prenom: "Camille", abonnement_valide: "oui" as const };
const eleves = { saison: "2026 / 2027", lignes: [{ licence: ligne.licence, nom: ligne.nom, prenom: ligne.prenom, cours: "Adultes" }] };

async function cache(t: ReturnType<typeof creerTest>) {
  return await t.run(async (ctx) => await ctx.db.query("abo_compteur_public_cache").first());
}

async function invalidation(t: ReturnType<typeof creerTest>) {
  return await t.run(async (ctx) => await ctx.db.query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", "compteur_public_a_recalculer")).first());
}

afterEach(() => vi.useRealTimers());

describe("recalcul du compteur après les imports", () => {
  test.each(["manuelle", "automatique"])("l'association %s dédoublonne immédiatement la demande avec le site", async (mode) => {
    vi.useFakeTimers();
    const t = creerTest();
    const { adminId, personneId } = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert("users", { email: "admin@example.test" });
      await ctx.db.insert("userSettings", { userId: adminId, allowedTiles: ["abonnements"], role: "admin" });
      const ownerId = await ctx.db.insert("users", { email: "candidat@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "candidat@example.test", owner_id: ownerId, statut_dossier: "validee", date_soumission: "2026-09-01T00:00:00.000Z",
      });
      const personneId = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "DUPONT", prenom: "Camille", nom_prenom_normalise: "DUPONT CAMILLE", licence_statut: "inconnu",
        etape_demande: true, etape_validation: "validee", etape_licence: false, etape_inscription_site: false,
        etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
      });
      await ctx.db.insert("abo_licences", {
        licence: ligne.licence, nom: ligne.nom, prenom: ligne.prenom, nom_prenom_normalise: "DUPONT CAMILLE", imported_at: "2026-09-01T00:00:00.000Z",
      });
      return { adminId, personneId };
    });
    const scrap = { ...ligne, nom: "MARTIN", prenom: "Jeanne" };
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [scrap] });
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, {});
    expect(await cache(t)).toMatchObject({ occupe: 2 });
    const admin = t.withIdentity({ subject: adminId });
    if (mode === "manuelle") {
      await admin.mutation(api.abo.licences.validerLicence, { personneId, licence: ligne.licence });
    } else {
      expect(await admin.mutation(api.abo.licences.resoudreLicencesPersonnes, {})).toBe(1);
    }
    expect(await invalidation(t)).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await cache(t)).toMatchObject({ occupe: 1 });
    expect(await invalidation(t)).toBeNull();
    // Un prochain snapshot identique peut maintenant ignorer le recalcul.
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [scrap] });
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, { siNecessaire: true });
    expect(await cache(t)).toMatchObject({ occupe: 1 });
    const avant = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    if (mode === "manuelle") {
      await admin.mutation(api.abo.licences.validerLicence, { personneId, licence: ligne.licence });
    } else {
      expect(await admin.mutation(api.abo.licences.resoudreLicencesPersonnes, {})).toBe(0);
    }
    expect(await invalidation(t)).toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).toEqual(avant);
  });

  test("un lot identique conserve le cache ; un changement reste invalidé jusqu'au recalcul", async () => {
    const t = creerTest();
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [ligne] });
    expect(await invalidation(t)).not.toBeNull();
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, { siNecessaire: true });
    expect(await invalidation(t)).toBeNull();
    const avant = await cache(t);
    expect(await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [ligne] }))
      .toEqual({ upsertees: 1, sansLicence: 0 });
    expect(await invalidation(t)).toBeNull();
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, { siNecessaire: true });
    expect(await cache(t)).toEqual(avant);

    const changement = { ...ligne, abonnement_valide: "non" as const };
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [changement] });
    const marqueur = await invalidation(t);
    // Simule une action interrompue après son lot, puis un retry identique.
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [changement] });
    expect(await invalidation(t)).toEqual(marqueur);
    expect(marqueur).not.toBeNull();
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, {});
    expect(await invalidation(t)).toBeNull();
  });

  test("initialise le cache absent même sans invalidation", async () => {
    const t = creerTest();
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, { siNecessaire: true });
    expect(await cache(t)).toMatchObject({ cle: "courant", occupe: 0 });
  });

  test("sans invalidation le mode conditionnel ne recalcule pas les sources", async () => {
    const t = creerTest();
    // Une valeur sentinelle permet de distinguer un recalcul sans écriture
    // d'un vrai court-circuit : un calcul sur les sources vides donnerait zéro.
    await t.run(async (ctx) => await ctx.db.insert("abo_compteur_public_cache", {
      cle: "courant", occupe: 42, places_max: 250, places_restantes: 208, calcule_le: "2026-09-01T00:00:00.000Z",
    }));
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, { siNecessaire: true });
    expect(await cache(t)).toMatchObject({ occupe: 42 });
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, {});
    expect(await cache(t)).toMatchObject({ occupe: 0 });
  });

  test("une suppression d'abonné invalide aussi le cache", async () => {
    const t = creerTest();
    await t.mutation(internal.abo.matching.upsertAbonnesScrapBatch, { lignes: [ligne] });
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, {});
    await t.mutation(internal.abo.matching.supprimerAbonnesScrapAbsents, { licences: ["987654321098"] });
    expect(await invalidation(t)).not.toBeNull();
  });

  test("les élèves inchangés n'ordonnancent rien, les insertions, modifications et suppressions oui", async () => {
    vi.useFakeTimers();
    const t = creerTest();
    await t.mutation(internal.abo.compteur.rafraichirCompteurPublic, {});
    const planifies = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, eleves);
    expect(await planifies()).toBe(1);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, eleves);
    expect(await planifies()).toBe(1);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, { ...eleves, lignes: [{ ...eleves.lignes[0], nom: "MARTIN" }] });
    expect(await planifies()).toBe(2);
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, { ...eleves, lignes: [] });
    expect(await planifies()).toBe(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("un snapshot élèves identique reconstruit un cache manquant", async () => {
    vi.useFakeTimers();
    const t = creerTest();
    await t.mutation(internal.abo.compteur.remplacerElevesEnCours, { saison: eleves.saison, lignes: [] });
    expect(await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await cache(t)).not.toBeNull();
  });
});
