// File durable des règlements déjà archivés dans Drive par n8n, puis
// rapprochement manuel avec l'annuaire des licences.

import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { authenticatedQuery } from "../customFunctions";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireAboAdmin } from "./auth";
import { canoniserLicence, normaliserNomPrenom } from "./lib";
import { confirmerLicencePersonneCourante } from "./reglements";
import { REGLEMENT_VERSION } from "./reglementsConstants";

const MAX_TAILLE_PAGE = 50;

const candidatValidator = v.object({
  licence: v.string(),
  nom: v.string(),
  prenom: v.string(),
  score: v.number(),
  correspondance: v.union(v.literal("exacte"), v.literal("approchee")),
});

const importVueValidator = v.object({
  id: v.id("abo_reglements_imports"),
  pdfUrl: v.string(),
  identiteExtraite: v.string(),
  importeLe: v.string(),
  candidats: v.array(candidatValidator),
});

const reglementValidator = v.object({
  id: v.id("abo_reglements_signes"),
  driveFileId: v.string(),
  driveUrl: v.string(),
  nomFichier: v.string(),
  nom: v.string(),
  prenom: v.string(),
  licence: v.string(),
  statut: v.union(v.literal("a_enregistrer"), v.literal("enregistre")),
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

async function candidatsExactsPourImport(
  ctx: QueryCtx,
  row: Doc<"abo_reglements_imports">,
) {
  if (!row.nom_extrait || !row.prenom_extrait) return [];
  const identites = [
    normaliserNomPrenom(row.nom_extrait, row.prenom_extrait),
    normaliserNomPrenom(row.prenom_extrait, row.nom_extrait),
  ];
  // IO-BOUNDED: deux recherches indexées au plus par règlement, quel que soit
  // le nombre de licences dans l'annuaire.
  const fiches = await Promise.all(
    [...new Set(identites)].map((identite) =>
      ctx.db
        .query("abo_licences")
        .withIndex("by_nom_prenom_normalise", (q) =>
          q.eq("nom_prenom_normalise", identite),
        )
        .take(5),
    ),
  );
  const uniques = new Map<string, Doc<"abo_licences">>();
  for (const fiche of fiches.flat()) uniques.set(fiche.licence, fiche);
  return [...uniques.values()]
    .filter((fiche) => fiche.nom && fiche.prenom)
    .map((fiche) => ({
      licence: fiche.licence,
      nom: fiche.nom!,
      prenom: fiche.prenom!,
      score: 1,
      correspondance: "exacte" as const,
    }));
}

export const listerARapprocher = authenticatedQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(importVueValidator),
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
      .query("abo_reglements_imports")
      .withIndex("by_statut", (q) => q.eq("statut", "a_rapprocher"))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const row of resultat.page) {
      if (!row.identite_extraite) continue;
      const pdfUrl = row.drive_file_id
        ? `https://drive.google.com/file/d/${encodeURIComponent(row.drive_file_id)}/preview`
        : row.storage_id
          ? await ctx.storage.getUrl(row.storage_id)
          : null;
      if (!pdfUrl) continue;
      page.push({
        id: row._id,
        pdfUrl,
        identiteExtraite: row.identite_extraite,
        importeLe: row.importe_le,
        candidats: await candidatsExactsPourImport(ctx, row),
      });
    }
    return { ...resultat, page };
  },
});

export const contexteLiaisonDrive = internalQuery({
  args: { importId: v.id("abo_reglements_imports"), licence: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("deja_lie"), reglement: reglementValidator }),
    v.object({
      kind: v.literal("a_verifier"),
      driveFileId: v.string(),
      versionReglement: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const licence = canoniserLicence(args.licence);
    if (!licence) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_INVALIDE",
        message: "Le numéro de licence est invalide.",
      });
    }
    const importDoc = await ctx.db.get(args.importId);
    if (!importDoc) {
      throw new ConvexError({
        code: "REGLEMENT_IMPORT_INTROUVABLE",
        message: "Ce règlement importé est introuvable.",
      });
    }
    if (importDoc.statut === "lie" && importDoc.reglement_id) {
      const dejaLie = await ctx.db.get(importDoc.reglement_id);
      if (dejaLie?.licence === licence) {
        return { kind: "deja_lie" as const, reglement: vueReglement(dejaLie) };
      }
      throw new ConvexError({
        code: "REGLEMENT_IMPORT_DEJA_LIE",
        message: "Ce règlement est déjà lié à une autre licence.",
      });
    }
    if (
      importDoc.statut !== "a_rapprocher" ||
      !importDoc.drive_file_id
    ) {
      throw new ConvexError({
        code: "REGLEMENT_IMPORT_INCOMPLET",
        message: "Ce règlement ne peut pas être rapproché.",
      });
    }
    return {
      kind: "a_verifier" as const,
      driveFileId: importDoc.drive_file_id,
      versionReglement: importDoc.version_reglement,
    };
  },
});

export const finaliserLiaisonDrive = internalMutation({
  args: {
    importId: v.id("abo_reglements_imports"),
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
    if (!licence) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_INVALIDE",
        message: "Le numéro de licence est invalide.",
      });
    }
    const importDoc = await ctx.db.get(args.importId);
    if (!importDoc || importDoc.drive_file_id !== args.driveFileId) {
      throw new ConvexError({
        code: "REGLEMENT_IMPORT_MODIFIE",
        message: "Ce règlement a changé depuis sa vérification Drive.",
      });
    }
    if (importDoc.statut === "lie" && importDoc.reglement_id) {
      const dejaLie = await ctx.db.get(importDoc.reglement_id);
      if (dejaLie?.licence === licence) {
        return vueReglement(dejaLie);
      }
    }
    if (
      importDoc.statut !== "a_rapprocher" ||
      importDoc.version_reglement !== args.versionReglement
    ) {
      throw new ConvexError({
        code: "REGLEMENT_IMPORT_MODIFIE",
        message: "Ce règlement ne peut plus être rapproché.",
      });
    }
    const fiche = await ctx.db
      .query("abo_licences")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .unique();
    if (!fiche?.nom || !fiche.prenom) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_INTROUVABLE",
        message: "Cette licence n'existe pas dans l'annuaire.",
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
    if (
      parFichier &&
      (parFichier.licence !== licence ||
        parFichier.version_reglement !== args.versionReglement)
    ) {
      throw new ConvexError({
        code: "REGLEMENT_FICHIER_DEJA_LIE",
        message: "Ce fichier Drive est déjà lié à une autre licence ou version.",
      });
    }
    if (parLicence && parLicence.drive_file_id !== args.driveFileId) {
      throw new ConvexError({
        code: "REGLEMENT_LICENCE_DEJA_LIEE",
        message: "Un règlement de cette version est déjà lié à cette licence.",
      });
    }
    let reglement = parFichier ?? parLicence;
    if (!reglement) {
      const reglementId = await ctx.db.insert("abo_reglements_signes", {
        drive_file_id: args.driveFileId,
        drive_file_name: args.driveFileName,
        drive_url: args.driveUrl,
        version_reglement: args.versionReglement,
        nom: fiche.nom,
        prenom: fiche.prenom,
        nom_prenom_normalise: normaliserNomPrenom(fiche.nom, fiche.prenom),
        licence,
        liaison_validee_par: args.userId,
        liaison_validee_le: new Date().toISOString(),
        statut_site: "a_enregistrer",
      });
      reglement = await ctx.db.get(reglementId);
    }
    if (!reglement) {
      throw new ConvexError({
        code: "REGLEMENT_LIAISON_ECHEC",
        message: "La liaison du règlement n'a pas pu être enregistrée.",
      });
    }
    await ctx.db.patch(importDoc._id, {
      statut: "lie",
      reglement_id: reglement._id,
      drive_file_name: args.driveFileName,
      drive_url: args.driveUrl,
    });
    await confirmerLicencePersonneCourante(
      ctx,
      licence,
      normaliserNomPrenom(fiche.nom, fiche.prenom),
      normaliserNomPrenom(fiche.prenom, fiche.nom),
    );
    return vueReglement(reglement);
  },
});
