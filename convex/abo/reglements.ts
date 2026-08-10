// Suivi administratif des règlements signés pour la campagne en cours. Les PDF
// restent dans Drive ; leurs liaisons et statuts Convex sont purgés au reset.

import { ConvexError, v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { authenticatedMutation, authenticatedQuery } from "../customFunctions";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireAboAdmin } from "./auth";
import { canoniserLicence, normaliserNomPrenom } from "./lib";
import { REGLEMENT_VERSION } from "./reglementsConstants";

const MAX_RECHERCHE_LICENCES = 10;
const MAX_LONGUEUR_NOM = 100;
const MAX_ANNUAIRE_RECHERCHE = 5_000;
const MAX_TAILLE_PAGE = 50;
const MAX_BADGE = 100;

const statutValidator = v.union(
  v.literal("a_enregistrer"),
  v.literal("enregistre"),
);

const licenceValidator = v.object({
  licence: v.string(),
  nom: v.string(),
  prenom: v.string(),
});

const reglementValidator = v.object({
  id: v.id("abo_reglements_signes"),
  driveFileId: v.string(),
  driveUrl: v.string(),
  nomFichier: v.string(),
  nom: v.string(),
  prenom: v.string(),
  licence: v.string(),
  statut: statutValidator,
});

function vueReglement(row: Doc<"abo_reglements_signes">) {
  return {
    id: row._id,
    driveFileId: row.drive_file_id,
    driveUrl: row.drive_url,
    nomFichier: row.drive_file_name,
    nom: row.nom,
    prenom: row.prenom,
    licence: row.licence,
    statut: row.statut_site,
  };
}

export async function confirmerLicencePersonneCourante(
  ctx: MutationCtx,
  licence: string,
  identiteDirecte: string,
  identiteInversee: string,
): Promise<void> {
  const personnes = await ctx.db
    .query("abo_personnes")
    .withIndex("by_licence", (q) => q.eq("licence", licence))
    .take(2);
  if (personnes.length !== 1) return;
  const personne = personnes[0];
  if (
    personne.nom_prenom_normalise !== identiteDirecte &&
    personne.nom_prenom_normalise !== identiteInversee
  ) {
    return;
  }
  if (personne.licence_statut !== "annuaire_valide") {
    await ctx.db.patch(personne._id, { licence_statut: "annuaire_valide" });
  }
}

// Recherche déclenchée explicitement par le staff. Les fragments imposent un
// parcours borné de l'annuaire ; seuls les dix premiers résultats remontent.
export const rechercherLicencesParNom = authenticatedQuery({
  args: { nom: v.string(), prenom: v.string() },
  returns: v.array(licenceValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const nom = args.nom.trim();
    const prenom = args.prenom.trim();
    if (!nom && !prenom) return [];
    if (nom.length > MAX_LONGUEUR_NOM || prenom.length > MAX_LONGUEUR_NOM) {
      throw new ConvexError({
        code: "REGLEMENT_RECHERCHE_INVALIDE",
        message: "Le nom et le prénom doivent contenir au maximum 100 caractères.",
      });
    }

    const nomNormalise = nom ? normaliserNomPrenom(nom, "") : "";
    const prenomNormalise = prenom ? normaliserNomPrenom(prenom, "") : "";
    // IO-BOUNDED: la recherche par fragment ne peut utiliser un index Convex.
    // Elle ne se déclenche qu'au clic, parcourt au plus 5 000 licences et
    // refuse explicitement une croissance supérieure plutôt que d'ignorer des fiches.
    const annuaire = await ctx.db.query("abo_licences").take(MAX_ANNUAIRE_RECHERCHE + 1);
    if (annuaire.length > MAX_ANNUAIRE_RECHERCHE) {
      throw new ConvexError({
        code: "REGLEMENT_ANNUAIRE_TROP_GRAND",
        message: "L'annuaire dépasse 5 000 licences : contactez un administrateur.",
      });
    }
    return annuaire
      .filter((row) => {
        if (!row.nom || !row.prenom) return false;
        const nomFiche = normaliserNomPrenom(row.nom, "");
        const prenomFiche = normaliserNomPrenom(row.prenom, "");
        return (
          (!nomNormalise || nomFiche.includes(nomNormalise)) &&
          (!prenomNormalise || prenomFiche.includes(prenomNormalise))
        );
      })
      .slice(0, MAX_RECHERCHE_LICENCES)
      .flatMap((row) =>
        row.nom && row.prenom
          ? [{ licence: row.licence, nom: row.nom, prenom: row.prenom }]
          : [],
      );
  },
});

export const lister = authenticatedQuery({
  args: { statut: statutValidator, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(reglementValidator),
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > MAX_TAILLE_PAGE
    ) {
      throw new ConvexError({
        code: "REGLEMENT_PAGINATION_INVALIDE",
        message: "Une page doit contenir entre 1 et 50 règlements.",
      });
    }
    const resultat = await ctx.db
      .query("abo_reglements_signes")
      .withIndex("by_statut_site", (q) => q.eq("statut_site", args.statut))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...resultat, page: resultat.page.map(vueReglement) };
  },
});

// Le badge n'a pas besoin d'un décompte non borné : il est plafonné à 100.
export const compterAEnregistrer = authenticatedQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const rows = await ctx.db
      .query("abo_reglements_signes")
      .withIndex("by_statut_site", (q) => q.eq("statut_site", "a_enregistrer"))
      .take(MAX_BADGE + 1);
    return Math.min(rows.length, MAX_BADGE);
  },
});

// Compteur global du badge Règlements : rapprochements webhook et saisies site.
// Les lectures indexées s'arrêtent au plafond d'affichage.
export const compterActions = authenticatedQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const imports = await ctx.db
      .query("abo_reglements_imports")
      .withIndex("by_statut", (q) => q.eq("statut", "a_rapprocher"))
      .take(MAX_BADGE + 1);
    if (imports.length > MAX_BADGE) return MAX_BADGE;
    const restantes = MAX_BADGE - imports.length;
    const archives = await ctx.db
      .query("abo_reglements_signes")
      .withIndex("by_statut_site", (q) => q.eq("statut_site", "a_enregistrer"))
      .take(restantes + 1);
    return Math.min(imports.length + archives.length, MAX_BADGE);
  },
});

export const marquerEnregistreSite = authenticatedMutation({
  args: { reglementId: v.id("abo_reglements_signes") },
  returns: reglementValidator,
  handler: async (ctx, args) => {
    const admin = await requireAboAdmin(ctx);
    const row = await ctx.db.get(args.reglementId);
    if (!row) {
      throw new ConvexError({
        code: "REGLEMENT_INTROUVABLE",
        message: "Ce règlement signé est introuvable.",
      });
    }
    if (row.statut_site === "enregistre") return vueReglement(row);

    const maintenant = new Date().toISOString();
    await ctx.db.patch(row._id, {
      statut_site: "enregistre",
      enregistre_site_par: admin.userId,
      enregistre_site_le: maintenant,
    });
    return vueReglement({
      ...row,
      statut_site: "enregistre",
      enregistre_site_par: admin.userId,
      enregistre_site_le: maintenant,
    });
  },
});

// Appelée uniquement après que l'action Node a vérifié le fichier auprès de
// Google Drive. Les deux clés naturelles sont recontrôlées dans la transaction.
export const lierReglementInterne = internalMutation({
  args: {
    userId: v.id("users"),
    licence: v.string(),
    driveFileId: v.string(),
    driveFileName: v.string(),
    driveUrl: v.string(),
    versionReglement: v.string(),
  },
  returns: reglementValidator,
  handler: async (ctx, args) => {
    if (args.versionReglement !== REGLEMENT_VERSION) {
      throw new ConvexError({
        code: "REGLEMENT_VERSION_INVALIDE",
        message: "La version du règlement ne correspond pas au formulaire courant.",
      });
    }
    const licence = canoniserLicence(args.licence);
    if (!licence || !args.driveFileId.trim()) {
      throw new ConvexError({
        code: "REGLEMENT_LIAISON_INVALIDE",
        message: "Le fichier Drive et le numéro de licence sont obligatoires.",
      });
    }
    const fiche = await ctx.db
      .query("abo_licences")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (!fiche || !fiche.nom || !fiche.prenom) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_INTROUVABLE",
        message: "Cette licence n'existe pas dans l'annuaire.",
      });
    }
    const stemFichier = args.driveFileName.trim().replace(/\.[^.]+$/, "");
    const identiteFichier = normaliserNomPrenom(stemFichier, "");
    const identiteDirecte = normaliserNomPrenom(fiche.nom, fiche.prenom);
    const identiteInversee = normaliserNomPrenom(fiche.prenom, fiche.nom);
    if (
      !stemFichier ||
      (identiteFichier !== identiteDirecte &&
        identiteFichier !== identiteInversee)
    ) {
      throw new ConvexError({
        code: "REGLEMENT_IDENTITE_FICHIER_INVALIDE",
        message:
          "Le nom du fichier Drive ne correspond pas au nom et au prénom de cette licence.",
      });
    }

    const [parFichier, parLicence] = await Promise.all([
      ctx.db
        .query("abo_reglements_signes")
        .withIndex("by_drive_file_id", (q) =>
          q.eq("drive_file_id", args.driveFileId),
        )
        .unique(),
      ctx.db
        .query("abo_reglements_signes")
        .withIndex("by_version_reglement_and_licence", (q) =>
          q.eq("version_reglement", args.versionReglement).eq("licence", licence),
        )
        .unique(),
    ]);

    if (parFichier) {
      if (
        parFichier.version_reglement === args.versionReglement &&
        parFichier.licence === licence
      ) {
        await confirmerLicencePersonneCourante(
          ctx,
          licence,
          identiteDirecte,
          identiteInversee,
        );
        return vueReglement(parFichier);
      }
      throw new ConvexError({
        code: "REGLEMENT_FICHIER_DEJA_LIE",
        message: "Ce fichier Drive est déjà lié à une autre licence.",
      });
    }
    if (parLicence) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_DEJA_LIEE",
        message: "Un règlement de cette version est déjà lié à cette licence.",
      });
    }

    const maintenant = new Date().toISOString();
    const id = await ctx.db.insert("abo_reglements_signes", {
      drive_file_id: args.driveFileId,
      drive_file_name: args.driveFileName,
      drive_url: args.driveUrl,
      version_reglement: args.versionReglement,
      nom: fiche.nom,
      prenom: fiche.prenom,
      nom_prenom_normalise: normaliserNomPrenom(fiche.nom, fiche.prenom),
      licence,
      liaison_validee_par: args.userId,
      liaison_validee_le: maintenant,
      statut_site: "a_enregistrer",
    });
    const inserted = await ctx.db.get(id);
    if (!inserted) {
      throw new ConvexError({
        code: "REGLEMENT_LIAISON_ECHEC",
        message: "La liaison du règlement n'a pas pu être enregistrée.",
      });
    }
    await confirmerLicencePersonneCourante(
      ctx,
      licence,
      identiteDirecte,
      identiteInversee,
    );
    return vueReglement(inserted);
  },
});
