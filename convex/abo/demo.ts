// Jeu de démonstration local des règles Abonnements.
// Commandes DEV : npx convex run abo/demo:seed, puis abo/demo:clear.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normaliserNomPrenom } from "./lib";
import { programmerRafraichissementCompteurPublic } from "./compteur";
import {
  supprimerProjectionEleveEnCours,
  upsertProjectionEleveEnCours,
} from "./compteurCache";

const MANIFEST_KEY = "demo_abonnements_2026";
const DEMO_NOW = "2026-08-07T10:00:00.000Z";

function exigerDemoAutorisee(): void {
  if (process.env.ALLOW_ABO_DEMO !== "true") {
    throw new ConvexError({
      code: "ABO_DEMO_INTERDITE",
      message: "La démonstration est désactivée sur ce déploiement.",
    });
  }
}

type DemoManifest = {
  dossiers: Id<"abo_dossiers">[];
  personnes: Id<"abo_personnes">[];
  scrap: Id<"abo_abonnes_scrap">[];
  archive: Id<"abo_abonnes_archive">[];
  eleves: Id<"abo_eleves_en_cours">[];
  ownerId?: Id<"users">;
  configAvant: Record<string, string | null>;
};

async function lireConfig(ctx: MutationCtx, cle: string) {
  return await ctx.db
    .query("abo_app_config")
    .withIndex("by_cle", (q) => q.eq("cle", cle))
    .first();
}

async function lireManifeste(
  ctx: MutationCtx,
): Promise<{ row: Doc<"abo_app_config">; manifest: DemoManifest } | null> {
  const row = await lireConfig(ctx, MANIFEST_KEY);
  if (!row || !row.valeur) return null;
  try {
    return { row, manifest: JSON.parse(row.valeur) as DemoManifest };
  } catch {
    throw new Error("Le manifeste de démonstration Abonnements est illisible.");
  }
}

async function restaurerConfig(ctx: MutationCtx, configAvant: DemoManifest["configAvant"]) {
  for (const [cle, valeur] of Object.entries(configAvant)) {
    const row = await lireConfig(ctx, cle);
    if (valeur === null) {
      if (row) await ctx.db.delete(row._id);
    } else if (row) {
      await ctx.db.patch(row._id, { valeur, updated_at: DEMO_NOW });
    } else {
      await ctx.db.insert("abo_app_config", { cle, valeur, updated_at: DEMO_NOW });
    }
  }
}

async function effacerDemo(ctx: MutationCtx) {
  const contenu = await lireManifeste(ctx);
  if (!contenu) return 0;
  const { row, manifest } = contenu;
  for (const id of manifest.scrap) await ctx.db.delete(id);
  for (const id of manifest.archive) await ctx.db.delete(id);
  for (const id of manifest.eleves) {
    await supprimerProjectionEleveEnCours(ctx, id);
    await ctx.db.delete(id);
  }
  for (const id of manifest.personnes) await ctx.db.delete(id);
  for (const id of manifest.dossiers) await ctx.db.delete(id);
  if (manifest.ownerId) await ctx.db.delete(manifest.ownerId);
  await restaurerConfig(ctx, manifest.configAvant);
  await ctx.db.delete(row._id);
  return manifest.personnes.length + manifest.scrap.length + manifest.archive.length
    + manifest.eleves.length + manifest.dossiers.length;
}

async function poserConfig(ctx: MutationCtx, cle: string, valeur: string) {
  const row = await lireConfig(ctx, cle);
  if (row) await ctx.db.patch(row._id, { valeur, updated_at: DEMO_NOW });
  else await ctx.db.insert("abo_app_config", { cle, valeur, updated_at: DEMO_NOW });
}

export const seed = internalMutation({
  args: {},
  returns: v.object({
    dossiers: v.number(),
    personnes: v.number(),
    inscriptionsSite: v.number(),
  }),
  handler: async (ctx) => {
    exigerDemoAutorisee();
    await effacerDemo(ctx);
    const configKeys = ["places_max", "vague2_debut", "vague3_debut"];
    const configAvant: DemoManifest["configAvant"] = {};
    for (const cle of configKeys) configAvant[cle] = (await lireConfig(ctx, cle))?.valeur ?? null;
    // Vague 3 est ouverte : le portail est accessible à toutes et tous.
    await poserConfig(ctx, "places_max", "8");
    await poserConfig(ctx, "vague2_debut", "2026-01-01T08:00");
    await poserConfig(ctx, "vague3_debut", "2026-08-01T08:00");

    const ownerId = await ctx.db.insert("users", { email: "abo-demo-owner@demo.local" });
    const dossiers: Id<"abo_dossiers">[] = [];
    const personnes: Id<"abo_personnes">[] = [];
    const scrap: Id<"abo_abonnes_scrap">[] = [];
    const archive: Id<"abo_abonnes_archive">[] = [];
    const eleves: Id<"abo_eleves_en_cours">[] = [];

    const ajouterDossier = async (
      prenom: string,
      nom: string,
      statut: Doc<"abo_dossiers">["statut_dossier"],
      validation: Doc<"abo_personnes">["etape_validation"],
      options: Partial<Pick<Doc<"abo_personnes">, "vague_depot" | "licence">> = {},
    ) => {
      const dossierId = await ctx.db.insert("abo_dossiers", {
        owner_id: ownerId,
        email: prenom.toLowerCase() + "." + nom.toLowerCase() + "@demo.local",
        statut_dossier: statut,
        date_soumission: DEMO_NOW,
        commentaire: "Donnée de démonstration. Lancez abo/demo:clear pour la retirer.",
      });
      dossiers.push(dossierId);
      personnes.push(await ctx.db.insert("abo_personnes", {
        dossier_id: dossierId,
        prenom,
        nom,
        nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        licence: options.licence,
        licence_statut: options.licence ? "saisie" : "inconnu",
        etape_demande: true,
        etape_validation: validation,
        etape_licence: false,
        etape_inscription_site: false,
        etape_photo: false,
        etape_paiement: false,
        etape_abonnement_valide: false,
        vague_depot: options.vague_depot ?? "vague_3",
        deposee_le: DEMO_NOW,
      }));
    };

    // Les cinq décisions visibles dans Dossiers.
    await ajouterDossier("Lina", "Validee", "validee", "validee", { licence: "999000000001" });
    await ajouterDossier("Mila", "Attente", "nouvelle_demande", "en_attente", { licence: "999000000002" });
    await ajouterDossier("Noe", "Liste", "liste_attente", "liste_attente", { licence: "999000000003" });
    await ajouterDossier("Romy", "Refusee", "refusee", "refusee", { licence: "999000000004" });
    await ajouterDossier("Theo", "Vague2", "validee", "validee", {
      licence: "999000000005", vague_depot: "vague_2",
    });
    await ajouterDossier("Emma", "Vague2", "nouvelle_demande", "en_attente", {
      licence: "999000000006", vague_depot: "vague_2",
    });
    // Deux homonymes : rapprochement portail volontairement ambigu.
    await ajouterDossier("Alex", "Homonyme", "nouvelle_demande", "en_attente");
    await ajouterDossier("Alex", "Homonyme", "nouvelle_demande", "en_attente");

    for (const [prenom, nom, licence, horaire] of [
      ["Theo", "Vague2", "999000000005", "Mardi 18 h"],
      ["Emma", "Vague2", "999000000006", "Jeudi 19 h"],
      ["Eleve", "SansDemande", "999000000007", "Lundi 17 h"],
    ] as const) {
      const eleve = {
        prenom, nom, licence, horaire, nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        imported_at: DEMO_NOW, saison: "DEMO-2026",
      };
      const eleveId = await ctx.db.insert("abo_eleves_en_cours", eleve);
      await upsertProjectionEleveEnCours(ctx, { _id: eleveId, ...eleve });
      eleves.push(eleveId);
    }

    archive.push(await ctx.db.insert("abo_abonnes_archive", {
      prenom: "Nina", nom: "N1", nom_prenom_normalise: "NINA N1",
      abonnement_valide: "oui", saison: "DEMO-2025-26",
    }));
    for (const saison of ["DEMO-2024-25", "DEMO-2025-26"]) {
      archive.push(await ctx.db.insert("abo_abonnes_archive", {
        prenom: "Alex", nom: "ArchiveAmbigue", nom_prenom_normalise: "ALEX ARCHIVEAMBIGUE",
        abonnement_valide: "oui", saison,
      }));
    }

    const ajouterScrap = async (prenom: string, nom: string, licence?: string) => {
      scrap.push(await ctx.db.insert("abo_abonnes_scrap", {
        prenom, nom, licence, nom_prenom_normalise: normaliserNomPrenom(nom, prenom),
        abonnement_valide: "non", last_scrap_at: DEMO_NOW,
      }));
    };
    // Trois validées, quatre non validées, trois à vérifier : jamais de double compte.
    await ajouterScrap("Nina", "N1", "999000000010");
    await ajouterScrap("Lina", "Validee", "999000000001");
    await ajouterScrap("Theo", "Vague2", "999000000005");
    await ajouterScrap("Emma", "Vague2", "999000000006");
    await ajouterScrap("Mila", "Attente", "999000000002");
    await ajouterScrap("Noe", "Liste", "999000000003");
    await ajouterScrap("Romy", "Refusee", "999000000004");
    await ajouterScrap("Eleve", "SansDemande", "999000000007");
    await ajouterScrap("Alex", "Homonyme");
    await ajouterScrap("Alex", "ArchiveAmbigue", "999000000008");

    await ctx.db.insert("abo_app_config", {
      cle: MANIFEST_KEY,
      valeur: JSON.stringify({ dossiers, personnes, scrap, archive, eleves, ownerId, configAvant }),
      updated_at: DEMO_NOW,
    });
    await programmerRafraichissementCompteurPublic(ctx);
    return { dossiers: dossiers.length, personnes: personnes.length, inscriptionsSite: scrap.length };
  },
});

export const clear = internalMutation({
  args: {},
  returns: v.object({ supprimees: v.number() }),
  handler: async (ctx) => {
    exigerDemoAutorisee();
    const supprimees = await effacerDemo(ctx);
    await programmerRafraichissementCompteurPublic(ctx);
    return { supprimees };
  },
});
