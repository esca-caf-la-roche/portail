/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const MAINTENANT_MS = Date.parse("2026-08-07T12:00:00.000Z");

function createTest() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}

async function creerUtilisateur(t: ReturnType<typeof convexTest>, email: string) {
  const id = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("abo_profiles", { userId, email, role: "utilisateur" });
    return userId;
  });
  return t.withIdentity({ subject: id });
}

async function creerAdmin(t: ReturnType<typeof convexTest>) {
  const id = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "admin@example.test" });
    await ctx.db.insert("userSettings", { userId, allowedTiles: ["abonnements"], role: "user" });
    return userId;
  });
  return t.withIdentity({ subject: id });
}

describe("règles Abonnements : N-1, vague 2, suppression et anomalies", () => {
  test("refuse une personne N-1 par nom/prénom normalisé", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "n1@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague2_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-02T00:00" });
      await ctx.db.insert("abo_abonnes_archive", {
        nom: "Dupont", prenom: "Élise", nom_prenom_normalise: "DUPONT ELISE", abonnement_valide: "oui", saison: "2025-26",
      });
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "Dùpont", prenom: "Elise" }],
    })).rejects.toThrow("directement sur le site du club");
  });

  test("refuse un rapprochement N-1 ambigu au lieu de rediriger arbitrairement", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "ambigu@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague2_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-02T00:00" });
      for (const saison of ["2024-25", "2025-26"]) {
        await ctx.db.insert("abo_abonnes_archive", { nom: "Martin", prenom: "Lou", nom_prenom_normalise: "MARTIN LOU", abonnement_valide: "oui", saison });
      }
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "Martin", prenom: "Lou" }],
    })).rejects.toThrow("ambiguë");
  });

  test("limite durablement les recherches N-1 par compte", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "recherches-n1@example.test");
    const autre = await creerUtilisateur(t, "autre-recherche@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", {
        cle: "vague3_debut",
        valeur: "2020-01-01T00:00",
      });
      await ctx.db.insert("abo_abonnes_archive", {
        nom: "Recherche",
        prenom: "Limitee",
        nom_prenom_normalise: "RECHERCHE LIMITEE",
        abonnement_valide: "oui",
        saison: "2025-26",
      });
    });

    const tentative = {
      personnes: [{ nom: "Recherche", prenom: "Limitee" }],
    };
    for (let i = 0; i < 20; i++) {
      await expect(
        candidat.action(api.abo.demandes.creerDemande, tentative),
      ).rejects.toThrow("directement sur le site du club");
    }
    await expect(
      candidat.action(api.abo.demandes.creerDemande, tentative),
    ).rejects.toThrow("Trop de vérifications rapprochées");

    // La clé du quota est bien le compte connecté, pas une limite globale.
    await expect(
      autre.action(api.abo.demandes.creerDemande, tentative),
    ).rejects.toThrow("directement sur le site du club");
  });

  test("ne considère ni false, ni non, ni bloque comme un droit N-1", async () => {
    for (const [suffixe, statut] of [
      ["false", false],
      ["non", "non"],
      ["bloque", "bloque"],
    ] as const) {
      const t = createTest();
      const candidat = await creerUtilisateur(t, `${suffixe}@example.test`);
      await t.run(async (ctx) => {
        await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
        await ctx.db.insert("abo_abonnes_archive", {
          nom: "Historique",
          prenom: suffixe,
          nom_prenom_normalise: `HISTORIQUE ${suffixe.toUpperCase()}`,
          abonnement_valide: statut,
          saison: "2025-26",
        });
      });
      await expect(candidat.action(api.abo.demandes.creerDemande, {
        personnes: [{ nom: "Historique", prenom: suffixe }],
      })).resolves.toBeDefined();
    }
  });

  test("deux archives invalides ne créent pas une ambiguïté N-1", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "deux-invalides@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
      for (const abonnement_valide of ["non", "bloque"] as const) {
        await ctx.db.insert("abo_abonnes_archive", {
          nom: "Deux",
          prenom: "Invalides",
          nom_prenom_normalise: "DEUX INVALIDES",
          abonnement_valide,
          saison: "2025-26",
        });
      }
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "Deux", prenom: "Invalides" }],
    })).resolves.toBeDefined();
  });

  test("une archive valide et une invalide donnent un droit N-1 unique", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "mixte@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
      for (const abonnement_valide of ["oui", "non"] as const) {
        await ctx.db.insert("abo_abonnes_archive", {
          nom: "Archive",
          prenom: "Mixte",
          nom_prenom_normalise: "ARCHIVE MIXTE",
          abonnement_valide,
          saison: "2025-26",
        });
      }
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "Archive", prenom: "Mixte" }],
    })).rejects.toThrow("directement sur le site du club");
  });

  test("borne à 10 personnes et limite les champs publics", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "bornes@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: Array.from({ length: 11 }, (_, i) => ({ nom: `Nom${i}`, prenom: `Prenom${i}` })),
    })).rejects.toThrow("entre 1 et 10");
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      commentaire: "x".repeat(2_001),
      personnes: [{ nom: "Valide", prenom: "Nom" }],
    })).rejects.toThrow("2 000 caractères");
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "x".repeat(101), prenom: "Nom" }],
    })).rejects.toThrow("100 caractères");
    const licenceMalveillante = `7480${"9".repeat(100)}DONNEE_SENSIBLE`;
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ nom: "Licence", prenom: "Longue", licence: licenceMalveillante }],
    })).rejects.not.toThrow("DONNEE_SENSIBLE");
  });

  test("empêche l'ajout d'une onzième personne à un dossier existant", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "onze@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
    });
    await candidat.action(api.abo.demandes.creerDemande, {
      personnes: Array.from({ length: 10 }, (_, i) => ({ nom: `Nom${i}`, prenom: `Prenom${i}` })),
    });
    await expect(candidat.action(api.abo.demandes.ajouterPersonne, {
      nom: "Onzieme",
      prenom: "Personne",
    })).rejects.toThrow("limité à 10 personnes");
  });

  test("replace le dossier dans les nouvelles demandes lorsqu'une personne est ajoutée", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "ajout-apres-decision@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
      const owner = await ctx.db
        .query("abo_profiles")
        .withIndex("by_email", (q) => q.eq("email", "ajout-apres-decision@example.test"))
        .unique();
      const dossierId = await ctx.db.insert("abo_dossiers", {
        email: "ajout-apres-decision@example.test",
        owner_id: owner!.userId,
        statut_dossier: "validee",
        date_soumission: "2026-01-01T00:00:00.000Z",
      });
      await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId, nom: "Déjà", prenom: "Traitée", nom_prenom_normalise: "DEJA TRAITEE",
        licence_statut: "inconnu", etape_demande: true, etape_validation: "validee", etape_licence: false,
        etape_inscription_site: false, etape_photo: false, etape_paiement: false, etape_abonnement_valide: false,
        vague_depot: "vague_3", deposee_le: "2026-01-01T00:00:00.000Z",
      });
    });

    await candidat.action(api.abo.demandes.ajouterPersonne, { nom: "Nouvelle", prenom: "Personne" });
    const dossier = await candidat.query(api.abo.demandes.getMonDossier);

    expect(dossier?.statut_dossier).toBe("nouvelle_demande");
    expect(dossier?.personnes.map((personne) => personne.etape_validation)).toEqual([
      "validee",
      "en_attente",
    ]);
  });

  test("accepte la licence élève en vague 2 et refuse une licence inconnue", async () => {
    const t = createTest();
    const candidat = await creerUtilisateur(t, "eleve@example.test");
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague2_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2099-01-01T00:00" });
      await ctx.db.insert("abo_eleves_en_cours", { licence: "748000000001", nom: "Eleve", prenom: "Test", nom_prenom_normalise: "ELEVE TEST", imported_at: "2026-01-01T00:00:00.000Z" });
    });
    await expect(candidat.action(api.abo.demandes.creerDemande, {
      personnes: [{ licence: "748000000001" }],
    })).resolves.toBeDefined();
    const autre = await creerUtilisateur(t, "inconnu@example.test");
    await expect(autre.action(api.abo.demandes.creerDemande, {
      personnes: [{ licence: "748000000002" }],
    })).rejects.toThrow("n'est pas reconnue comme élève");
  });

  test("classe une ligne scrap avec demande en attente en non validée", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "owner@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", { email: "owner@example.test", owner_id: owner, statut_dossier: "nouvelle_demande", date_soumission: "2026-01-01T00:00:00.000Z" });
      await ctx.db.insert("abo_personnes", { dossier_id: dossierId, nom: "A", prenom: "B", nom_prenom_normalise: "A B", licence: "748000000003", licence_statut: "saisie", etape_demande: true, etape_validation: "en_attente", etape_licence: false, etape_inscription_site: false, etape_photo: false, etape_paiement: false, etape_abonnement_valide: false, vague_depot: "vague_3", deposee_le: "2026-01-01T00:00:00.000Z" });
      await ctx.db.insert("abo_abonnes_scrap", { licence: "748000000003", nom: "A", prenom: "B", nom_prenom_normalise: "A B", abonnement_valide: "non" });
    });
    const lignes = await admin.query(api.abo.compteur.vAnomalies, {});
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      type: "non_validee",
      controles: { statutDossier: "nouvelle_demande" },
      raison: expect.stringContaining("Règle 2 non respectée"),
    });
  });

  test("acquitte puis réactive une anomalie sans modifier les compteurs métier", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    const utilisateur = await creerUtilisateur(t, "sans-tuile@example.test");
    const scrapId = await t.run(async (ctx) => ctx.db.insert("abo_abonnes_scrap", {
      licence: "7480 0000 0021",
      nom: "Acquittement",
      prenom: "Manuel",
      nom_prenom_normalise: "ACQUITTEMENT MANUEL",
      abonnement_valide: "non",
    }));

    const avant = await admin.query(api.abo.compteur.vCompteur, {});
    const ligneAvant = (await admin.query(api.abo.compteur.vAnomalies, {}))[0];
    expect(ligneAvant).toMatchObject({
      code_anomalie: "absence_demande",
      statut: "a_traiter",
      acquittement: null,
    });
    await expect(utilisateur.mutation(api.abo.compteur.acquitterAnomalie, {
      scrapId,
      code_anomalie: "absence_demande",
      justification: "Cas contrôlé manuellement",
    })).rejects.toThrow("Réservé aux administrateurs");

    const acquittementId = await admin.mutation(api.abo.compteur.acquitterAnomalie, {
      scrapId,
      code_anomalie: "absence_demande",
      justification: "  Cas contrôlé manuellement  ",
    });
    await expect(admin.mutation(api.abo.compteur.acquitterAnomalie, {
      scrapId,
      code_anomalie: "absence_demande",
      justification: "Doublon",
    })).rejects.toThrow("déjà acquittée");

    const [apres, ligneAcquittee] = await Promise.all([
      admin.query(api.abo.compteur.vCompteur, {}),
      admin.query(api.abo.compteur.vAnomalies, {}).then((lignes) => lignes[0]),
    ]);
    expect(apres).toMatchObject({
      anomalies: 0,
      anomalies_brutes: 1,
      acquittees: 1,
      total_affiche: avant.total_affiche,
      occupe: avant.occupe,
    });
    expect(ligneAcquittee).toMatchObject({
      statut: "acquittee",
      acquittement: {
        id: acquittementId,
        justification: "Cas contrôlé manuellement",
      },
    });

    await admin.mutation(api.abo.compteur.reactiverAnomalie, { acquittementId });
    expect(await admin.query(api.abo.compteur.vCompteur, {})).toMatchObject({
      anomalies: 1,
      anomalies_brutes: 1,
      acquittees: 0,
      total_affiche: avant.total_affiche,
      occupe: avant.occupe,
    });
    const journal = await t.run(async (ctx) =>
      ctx.db.query("abo_anomalies_acquittements_journal").collect());
    expect(journal.map((entree) => entree.action)).toEqual(["acquittee", "reactivee"]);
  });

  test("un nouveau code d'anomalie n'est pas masqué par l'ancien acquittement", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    const scrapId = await t.run(async (ctx) => ctx.db.insert("abo_abonnes_scrap", {
      licence: "748000000022",
      nom: "Cause",
      prenom: "Changeante",
      nom_prenom_normalise: "CAUSE CHANGEANTE",
      abonnement_valide: "non",
    }));
    await admin.mutation(api.abo.compteur.acquitterAnomalie, {
      scrapId,
      code_anomalie: "absence_demande",
      justification: "Cause initiale vérifiée",
    });
    await t.run(async (ctx) => ctx.db.patch(scrapId, { abonnement_valide: false }));

    const ligne = (await admin.query(api.abo.compteur.vAnomalies, {}))[0];
    expect(ligne).toMatchObject({
      code_anomalie: "statut_inconnu",
      statut: "a_traiter",
      acquittement: null,
    });
    await expect(admin.mutation(api.abo.compteur.acquitterAnomalie, {
      scrapId,
      code_anomalie: "absence_demande",
      justification: "État devenu obsolète",
    })).rejects.toThrow("a changé");
  });

  test("purge l'état et le journal des anomalies par la machine de reset", async () => {
    const t = createTest();
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "audit@example.test" }));
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_anomalies_acquittements", {
        licence: "748000000023", code_anomalie: "absence_demande",
        justification: "À purger", acquittee_le: "2026-08-01T00:00:00.000Z", acquittee_par: userId,
      });
      await ctx.db.insert("abo_anomalies_acquittements_journal", {
        licence: "748000000023", code_anomalie: "absence_demande", action: "acquittee",
        justification: "À purger", date_action: "2026-08-01T00:00:00.000Z", auteur_id: userId,
      });
    });

    await t.mutation(internal.abo.config.purgerSuiviCampagne, {
      etape: "acquittements_anomalies",
    });
    await t.mutation(internal.abo.config.purgerSuiviCampagne, {
      etape: "journal_anomalies",
    });
    const restants = await t.run(async (ctx) => Promise.all([
      ctx.db.query("abo_anomalies_acquittements").collect(),
      ctx.db.query("abo_anomalies_acquittements_journal").collect(),
    ]));
    expect(restants).toEqual([[], []]);
  });

  test("exclut une ancienne valeur false du total et la signale comme inconnue", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_abonnes_scrap", {
        licence: "748000000088",
        nom: "Statut",
        prenom: "Ancien",
        nom_prenom_normalise: "STATUT ANCIEN",
        abonnement_valide: false,
      });
    });
    const [lignes, compteur] = await Promise.all([
      admin.query(api.abo.compteur.vAnomalies, {}),
      admin.query(api.abo.compteur.vCompteur, {}),
    ]);
    expect(lignes).toMatchObject([{
      abonnement_valide: "inconnu",
      type: "inconnue",
      raison: expect.stringContaining("Statut du site inconnu"),
    }]);
    expect(compteur).toMatchObject({ total_affiche: 0, occupe: 0, anomalies: 1 });
  });

  test.each([
    ["bloque", "BLOQUEE"],
    ["inconnu", "INCONNUE"],
  ] as const)(
    "ne recompte pas une demande validée reliée à une ligne scrap %s",
    async (abonnementValide, suffixe) => {
      const t = createTest();
      const admin = await creerAdmin(t);
      await t.run(async (ctx) => {
        const owner = await ctx.db.insert("users", { email: `${suffixe.toLowerCase()}@example.test` });
        const dossierId = await ctx.db.insert("abo_dossiers", {
          email: `${suffixe.toLowerCase()}@example.test`,
          owner_id: owner,
          statut_dossier: "validee",
          date_soumission: "2026-01-01T00:00:00.000Z",
        });
        await ctx.db.insert("abo_personnes", {
          dossier_id: dossierId,
          nom: "Demande",
          prenom: suffixe,
          nom_prenom_normalise: `DEMANDE ${suffixe}`,
          licence: `74800000${suffixe === "BLOQUEE" ? "0081" : "0082"}`,
          licence_statut: "saisie",
          etape_demande: true,
          etape_validation: "validee",
          etape_licence: false,
          etape_inscription_site: false,
          etape_photo: false,
          etape_paiement: false,
          etape_abonnement_valide: false,
        });
        await ctx.db.insert("abo_abonnes_scrap", {
          nom: "Demande",
          prenom: suffixe,
          nom_prenom_normalise: `DEMANDE ${suffixe}`,
          licence: `74800000${suffixe === "BLOQUEE" ? "0081" : "0082"}`,
          abonnement_valide: abonnementValide,
        });
      });
      const compteur = await admin.query(api.abo.compteur.vCompteur, {});
      expect(compteur).toMatchObject({
        demandes_validees: 1,
        validees_hors_legit: 0,
        total_affiche: 0,
        occupe: 0,
      });
    },
  );

  test("expose une correspondance N-1 ambiguë avec un motif explicite", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      for (const saison of ["2024-25", "2025-26"]) {
        await ctx.db.insert("abo_abonnes_archive", {
          nom: "Archive",
          prenom: "Ambigue",
          nom_prenom_normalise: "ARCHIVE AMBIGUE",
          abonnement_valide: "oui",
          saison,
        });
      }
      await ctx.db.insert("abo_abonnes_scrap", {
        nom: "Archive",
        prenom: "Ambigue",
        nom_prenom_normalise: "ARCHIVE AMBIGUE",
        abonnement_valide: "non",
      });
    });
    const lignes = await admin.query(api.abo.compteur.vAnomalies, {});
    expect(lignes).toMatchObject([{
      controles: { abonneN1: false, abonneN1Ambigu: true },
      raison: "Correspondance N-1 ambiguë : plusieurs archives validées portent ce nom et prénom. Vérifiez manuellement avant décision.",
    }]);
  });

  test("sert le compteur public depuis le singleton sans donnée nominative", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_compteur_public_cache", {
        cle: "courant",
        occupe: 12,
        places_max: 350,
        places_restantes: 338,
        calcule_le: "2026-08-07T00:00:00.000Z",
      });
    });
    const resultat = await t.query(api.abo.compteur.compteurPublic, {
      maintenantMs: MAINTENANT_MS,
    });
    expect(resultat).toEqual({ occupe: 12, places_max: 350, places_restantes: 338, vague: 3 });
    expect(Object.keys(resultat).sort()).toEqual(["occupe", "places_max", "places_restantes", "vague"]);
  });

  test("classe chaque inscription site dans une seule catégorie", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague2_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-02T00:00" });
      const owner = await ctx.db.insert("users", { email: "categories@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", { email: "categories@example.test", owner_id: owner, statut_dossier: "nouvelle_demande", date_soumission: "2026-01-01T00:00:00.000Z" });
      await ctx.db.insert("abo_abonnes_archive", { nom: "Archive", prenom: "Valide", nom_prenom_normalise: "ARCHIVE VALIDE", abonnement_valide: "oui", saison: "2025-26" });
      await ctx.db.insert("abo_abonnes_archive", { nom: "Archive", prenom: "Valide", nom_prenom_normalise: "ARCHIVE VALIDE", abonnement_valide: "non", saison: "2024-25" });
      await ctx.db.insert("abo_personnes", { dossier_id: dossierId, nom: "Portail", prenom: "Attente", nom_prenom_normalise: "PORTAIL ATTENTE", licence: "748000000010", licence_statut: "saisie", etape_demande: true, etape_validation: "en_attente", etape_licence: false, etape_inscription_site: false, etape_photo: false, etape_paiement: false, etape_abonnement_valide: false, vague_depot: "vague_3", deposee_le: "2026-01-01T00:00:00.000Z" });
      for (const [nom, prenom, licence] of [["Archive", "Valide", "748000000009"], ["Portail", "Attente", "748000000010"], ["Sans", "Demande", "748000000011"]] as const) {
        const estValideSurSite = nom === "Archive";
        await ctx.db.insert("abo_abonnes_scrap", { nom, prenom, licence, nom_prenom_normalise: `${nom.toUpperCase()} ${prenom.toUpperCase()}`, abonnement_valide: estValideSurSite ? "oui" : "non" });
      }
    });
    const [lignes, compteur] = await Promise.all([
      admin.query(api.abo.compteur.vAnomalies, {}),
      admin.query(api.abo.compteur.vCompteur, {}),
    ]);
    expect(lignes.map((ligne) => ligne.type)).toEqual(["non_validee", "non_validee"]);
    expect(lignes[1]?.raison).toContain("Règle 1 non respectée");
    expect(compteur).toMatchObject({
      abonnements_site_valides: 1,
      abonnements_site_non_valides_a_suivre: 2,
      bloquees: 0,
      anomalies: 2,
      total_affiche: 3,
      occupe: 1,
    });
  });

  test("classe validee une demande vague 2 même après l'ouverture de vague 3", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("abo_app_config", { cle: "vague2_debut", valeur: "2020-01-01T00:00" });
      await ctx.db.insert("abo_app_config", { cle: "vague3_debut", valeur: "2020-01-02T00:00" });
      const owner = await ctx.db.insert("users", { email: "a-temps@example.test" });
      const dossierId = await ctx.db.insert("abo_dossiers", { email: "a-temps@example.test", owner_id: owner, statut_dossier: "validee", date_soumission: "2026-01-01T00:00:00.000Z" });
      await ctx.db.insert("abo_personnes", { dossier_id: dossierId, nom: "A", prenom: "Temps", nom_prenom_normalise: "A TEMPS", licence: "748000000012", licence_statut: "saisie", etape_demande: true, etape_validation: "validee", etape_licence: false, etape_inscription_site: false, etape_photo: false, etape_paiement: false, etape_abonnement_valide: false, vague_depot: "vague_2", deposee_le: "2019-12-31T00:00:00.000Z" });
      await ctx.db.insert("abo_abonnes_scrap", { nom: "A", prenom: "Temps", licence: "748000000012", nom_prenom_normalise: "A TEMPS", abonnement_valide: "oui" });
    });
    const [lignes, compteur] = await Promise.all([
      admin.query(api.abo.compteur.vAnomalies, {}),
      admin.query(api.abo.compteur.vCompteur, {}),
    ]);
    expect(lignes).toEqual([]);
    expect(compteur.abonnements_site_valides).toBe(1);
  });

  test("autorise la validation vague 2 après l'ouverture de vague 3 et protège la suppression liée au site", async () => {
    const t = createTest();
    const admin = await creerAdmin(t);
    const candidat = await creerUtilisateur(t, "suppression@example.test");
    const personneId = await t.run(async (ctx) => {
      const owner = await ctx.db.query("users").filter((q) => q.eq(q.field("email"), "suppression@example.test")).unique();
      if (!owner) throw new Error("Utilisateur fixture introuvable");
      const dossierId = await ctx.db.insert("abo_dossiers", { email: "suppression@example.test", owner_id: owner._id, statut_dossier: "nouvelle_demande", date_soumission: "2026-01-01T00:00:00.000Z" });
      const id = await ctx.db.insert("abo_personnes", { dossier_id: dossierId, nom: "Site", prenom: "Lie", nom_prenom_normalise: "SITE LIE", licence: "748000000004", licence_statut: "saisie", etape_demande: true, etape_validation: "en_attente", etape_licence: false, etape_inscription_site: false, etape_photo: false, etape_paiement: false, etape_abonnement_valide: false, vague_depot: "vague_2", deposee_le: "2026-01-01T00:00:00.000Z" });
      await ctx.db.insert("abo_abonnes_scrap", { licence: "748000000099", nom: "Site", prenom: "Lie", nom_prenom_normalise: "SITE LIE", abonnement_valide: "non" });
      return id;
    });
    await expect(admin.mutation(api.abo.demandes.validerPersonne, { personneId, decision: "validee" })).resolves.toBeDefined();
    await expect(candidat.mutation(api.abo.demandes.supprimerPersonne, { personneId })).rejects.toThrow("Retirez d’abord cette inscription");
  });
});
