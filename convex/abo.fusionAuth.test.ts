/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("abo-otp refuse l'ancien email fusionné sans recréer le compte source", async () => {
  vi.stubEnv("SITE_URL", "https://app.example.test");
  try {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    const sourceId = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert("users", { email: "admin@example.test" });
      const sourceId = await ctx.db.insert("users", { email: "ancienne@example.test" });
      const canoniqueId = await ctx.db.insert("users", { email: "canonique@example.test" });
      const dossierSource = await ctx.db.insert("abo_dossiers", {
        email: "ancienne@example.test", owner_id: sourceId,
        statut_dossier: "nouvelle_demande", date_soumission: "2026-08-08T00:00:00.000Z",
      });
      const dossierCanonique = await ctx.db.insert("abo_dossiers", {
        email: "canonique@example.test", owner_id: canoniqueId,
        statut_dossier: "nouvelle_demande", date_soumission: "2026-08-08T00:00:00.000Z",
      });
      const personneSource = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierSource, nom: "Test", prenom: "Source", nom_prenom_normalise: "TEST SOURCE",
        licence: "123456789012", licence_statut: "saisie", etape_demande: true,
        etape_validation: "en_attente", etape_licence: true, etape_inscription_site: false,
        etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
      });
      const personneCanonique = await ctx.db.insert("abo_personnes", {
        dossier_id: dossierCanonique, nom: "Test", prenom: "Cible", nom_prenom_normalise: "TEST CIBLE",
        licence_statut: "inconnu", etape_demande: true, etape_validation: "en_attente",
        etape_licence: false, etape_inscription_site: false, etape_photo: false,
        etape_paiement: false, etape_abonnement_valide: false,
      });
      const fusionId = await ctx.db.insert("abo_fusions_dossiers", {
        licence_declencheur: "123456789012", mode_resolution: "conserver_b",
        dossier_a_id: dossierSource, dossier_b_id: dossierCanonique,
        owner_a_id: sourceId, owner_b_id: canoniqueId,
        email_a: "ancienne@example.test", email_b: "canonique@example.test",
        dossier_supprime_id: dossierSource,
        personne_a_doublon_id: personneSource, personne_b_doublon_id: personneCanonique,
        personne_conservee_id: personneCanonique, affectations_json: "[]",
        personnes_reaffectees: 0, reservations_reaffectees: 0, messages_reaffectes: 0,
        logs_reaffectes: 0, historiques_reaffectes: 0, compte_a: "desactive", compte_b: "conserve",
        resolue_le: "2026-08-08T00:00:00.000Z", resolue_par: adminId,
      });
      await ctx.db.insert("abo_fusion_redirections_email", {
        email_supprime: "ancienne@example.test", email_destination: "canonique@example.test",
        dossier_destination_id: dossierCanonique, fusion_id: fusionId,
        created_at: "2026-08-08T00:00:00.000Z",
      });
      return sourceId;
    });

    const normal = await t.action(api.auth.signIn, {
      provider: "abo-otp", params: { email: "normal@example.test" },
    });
    const argsFusionne = {
      provider: "abo-otp",
      params: { email: "ancienne@example.test" },
    };
    const fusionne = await t.action(api.auth.signIn, argsFusionne);
    expect(fusionne).toEqual(normal);
    await t.action(api.auth.signIn, argsFusionne);
    await t.action(api.auth.signIn, argsFusionne);
    await expect(t.action(api.auth.signIn, argsFusionne)).rejects.toThrow("Veuillez patienter");

    const etat = await t.run(async (ctx) => ({
      ancienne: await ctx.db.query("users").withIndex("email", q => q.eq("email", "ancienne@example.test")).first(),
      codes: await ctx.db.query("authVerificationCodes").collect(),
      profileAncien: await ctx.db.query("abo_profiles").withIndex("by_userId", q => q.eq("userId", sourceId)).first(),
    }));
    expect(etat.ancienne?._id).toBe(sourceId);
    expect(etat.profileAncien).toBeNull();
    expect(etat.codes.length).toBeGreaterThan(0);
  } finally {
    vi.unstubAllEnvs();
  }
});
