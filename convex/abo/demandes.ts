// Cœur du parcours Abonnements : demande (dossier + personnes) gatée par vague,
// suivi live, et vues admin (dossiers + validation par personne).
// Portage fidèle de :
//   - creer_demande_eleve.sql + anti_doublon_global.sql (creerDemande)
//   - ajouter_personne.sql + anti_doublon_global.sql (ajouterPersonne)
//   - supprimer_personne.sql (supprimerPersonne)
//   - mon_suivi.sql (monSuivi)
//   - valider_personne.sql (validerPersonne) + valider_dossier.sql (validerDossier)
//
// Sécurité : pas de RLS en Convex → chaque endpoint dérive l'identité côté serveur
// (getAuthUserId via authenticatedQuery/Mutation) et vérifie l'appartenance
// (owner_id === userId) ou le rôle admin via les helpers de ./auth.

import { v, ConvexError } from "convex/values";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import {
  authenticatedAction,
  authenticatedQuery,
  authenticatedMutation,
} from "../customFunctions";
import { internalMutation } from "../_generated/server";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { components, internal } from "../_generated/api";
import { requireAboIdentity, requireAboAdmin } from "./auth";
import { canoniserLicence, normaliserNomPrenom } from "./lib";
import { REGLEMENT_VERSION } from "./reglementsConstants";
import { vagueCourante } from "./config";
import { abonnementEstValide } from "./statutAbonnement";
import { canoniserEmailUnique } from "../emailValidation";
import {
  calculerCompteur,
  lirePlacesMax,
  programmerRafraichissementCompteurPublic,
} from "./compteur";

const MAX_PERSONNES_PAR_DOSSIER = 10;
const MAX_LONGUEUR_NOM = 100;
const MAX_LONGUEUR_COMMENTAIRE = 2_000;

const rateLimiter = new RateLimiter(components.rateLimiter, {
  aboDemandWrite: {
    kind: "fixed window",
    rate: 20,
    period: 10 * MINUTE,
  },
  // Une soumission peut contenir jusqu'à 10 personnes. Vingt vérifications
  // laissent donc la place à un dossier familial puis à une correction, tout
  // en empêchant les recherches répétées de noms dans l'archive N-1.
  aboN1Lookup: {
    kind: "fixed window",
    rate: 20,
    period: 10 * MINUTE,
  },
});

async function limiterTentativesN1(
  ctx: ActionCtx,
  userId: Id<"users">,
  nombrePersonnes: number,
): Promise<void> {
  const limite = await rateLimiter.limit(ctx, "aboN1Lookup", {
    key: userId,
    count: nombrePersonnes,
  });
  if (!limite.ok) {
    throw new ConvexError({
      code: "ABO_N1_RATE_LIMIT",
      message:
        "Trop de vérifications rapprochées. Patientez quelques minutes puis réessayez.",
    });
  }
}

async function limiterEcritureDemande(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const limite = await rateLimiter.limit(ctx, "aboDemandWrite", {
    key: userId,
  });
  if (!limite.ok) {
    throw new ConvexError({
      code: "ABO_RATE_LIMIT",
      message: "Trop de modifications rapprochées. Patientez quelques minutes puis réessayez.",
    });
  }
}

function verifierLongueursSaisie(saisie: {
  nom?: string;
  prenom?: string;
}): void {
  if ((saisie.nom ?? "").trim().length > MAX_LONGUEUR_NOM) {
    throw new ConvexError({ code: "22023", message: "Le nom est limité à 100 caractères." });
  }
  if ((saisie.prenom ?? "").trim().length > MAX_LONGUEUR_NOM) {
    throw new ConvexError({ code: "22023", message: "Le prénom est limité à 100 caractères." });
  }
}

// Statut de dossier → email transactionnel à envoyer (null si aucun).
type TypeEmailStatut = "validation" | "liste_attente" | "refus";
function typeEmailPourStatut(
  s: Doc<"abo_dossiers">["statut_dossier"],
): TypeEmailStatut | null {
  if (s === "validee") return "validation";
  if (s === "liste_attente") return "liste_attente";
  if (s === "refusee") return "refus";
  return null;
}

// Planifie l'email de changement de statut si le dossier bascule vers un état
// terminal (l'anti-doublon abo_email_log garantit un seul envoi par type).
async function planifierEmailStatut(
  ctx: MutationCtx,
  dossierId: Id<"abo_dossiers">,
  ancien: Doc<"abo_dossiers">["statut_dossier"],
  nouveau: Doc<"abo_dossiers">["statut_dossier"],
): Promise<void> {
  if (nouveau === ancien) return;
  const type = typeEmailPourStatut(nouveau);
  if (!type) return;
  await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerEmailAbo, {
    dossierId,
    typeEmail: type,
  });
}

const decisionValidator = v.union(
  v.literal("validee"),
  v.literal("liste_attente"),
  v.literal("refusee"),
);

const resultatDecisionPlafondValidator = v.object({
  decisionAppliquee: v.union(
    v.literal("validee"),
    v.literal("liste_attente"),
    v.literal("refusee"),
  ),
  plafond: v.number(),
  occupeAvant: v.number(),
  occupeApres: v.number(),
  derogationUtilisee: v.boolean(),
});

const statutDossierValidator = v.union(
  v.literal("nouvelle_demande"),
  v.literal("validee"),
  v.literal("liste_attente"),
  v.literal("refusee"),
  v.literal("complete"),
);

const personneVueValidator = v.object({
  id: v.id("abo_personnes"),
  nom: v.string(),
  prenom: v.string(),
  age: v.union(v.number(), v.null()),
  nom_prenom_normalise: v.string(),
  licence: v.union(v.string(), v.null()),
  licence_statut: v.union(
    v.literal("saisie"),
    v.literal("annuaire_auto"),
    v.literal("annuaire_valide"),
    v.literal("inconnu"),
  ),
  etape_demande: v.boolean(),
  etape_validation: v.union(
    v.literal("en_attente"),
    v.literal("validee"),
    v.literal("liste_attente"),
    v.literal("refusee"),
  ),
  etape_licence: v.boolean(),
  etape_test_autonomie: v.union(
    v.literal("non_requis"),
    v.literal("requis"),
    v.literal("valide"),
    v.null(),
  ),
  etape_inscription_site: v.boolean(),
  etape_photo: v.boolean(),
  etape_paiement: v.boolean(),
  etape_abonnement_valide: v.boolean(),
  vague_depot: v.union(
    v.literal("vague_2"),
    v.literal("vague_3"),
    v.literal("historique"),
  ),
  deposee_le: v.string(),
});

type DecisionValidation = Doc<"abo_personnes">["etape_validation"];
type DecisionDemandee = "validee" | "liste_attente" | "refusee";

interface ResultatDecisionPlafond {
  decisionAppliquee: DecisionDemandee;
  plafond: number;
  occupeAvant: number;
  occupeApres: number;
  derogationUtilisee: boolean;
}

// Évalue la capacité avec l'algorithme exact du compteur. Une dérogation est
// seulement considérée comme utilisée lorsqu'elle permet une nouvelle
// validation au-delà du plafond ; demander « validée » à 349/350 reste normal.
async function deciderAvecPlafond(
  ctx: MutationCtx,
  personnes: Doc<"abo_personnes">[],
  decisionDemandee: DecisionDemandee,
  autoriserDepassementPlafond: boolean | undefined,
  preserverValideesEnCasDePlafond = false,
): Promise<ResultatDecisionPlafond> {
  const [compteurAvant, plafond] = await Promise.all([
    calculerCompteur(ctx, undefined),
    lirePlacesMax(ctx),
  ]);
  const nouvellesValidations =
    decisionDemandee === "validee" &&
    personnes.some((personne) => personne.etape_validation !== "validee");
  const decisionsProjetees = new Map<Id<"abo_personnes">, DecisionValidation>(
    personnes.map((personne) => [personne._id, decisionDemandee]),
  );
  const compteurProjete = await calculerCompteur(ctx, decisionsProjetees);
  const depassement = nouvellesValidations && compteurProjete.occupe > plafond;
  const derogationUtilisee = depassement && autoriserDepassementPlafond === true;
  const decisionAppliquee: DecisionDemandee =
    depassement && !derogationUtilisee ? "liste_attente" : decisionDemandee;

  if (decisionAppliquee === decisionDemandee) {
    return {
      decisionAppliquee,
      plafond,
      occupeAvant: compteurAvant.occupe,
      occupeApres: compteurProjete.occupe,
      derogationUtilisee,
    };
  }

  const decisionsAppliquees = new Map<Id<"abo_personnes">, DecisionValidation>(
    personnes.map((personne) => [
      personne._id,
      preserverValideesEnCasDePlafond && personne.etape_validation === "validee"
        ? "validee"
        : decisionAppliquee,
    ]),
  );
  const compteurApplique = await calculerCompteur(ctx, decisionsAppliquees);
  return {
    decisionAppliquee,
    plafond,
    occupeAvant: compteurAvant.occupe,
    occupeApres: compteurApplique.occupe,
    derogationUtilisee,
  };
}

// Personne prête à insérer (identité + licence résolues selon la vague).
interface PersonneResolue {
  nom: string;
  prenom: string;
  licence: string | null;
  licence_statut: "saisie" | "inconnu";
}

type MetadonneesDepot = {
  vague_depot: "vague_2" | "vague_3";
  deposee_le: string;
};

function contexteDepot(vague: number): MetadonneesDepot {
  return {
    vague_depot: vague === 2 ? "vague_2" : "vague_3",
    deposee_le: new Date().toISOString(),
  };
}

// Un N-1 reconnu est une inscription validée de l'archive. La correspondance
// nom/prénom n'est valable que lorsqu'elle est strictement unique.
async function verifierN1(ctx: MutationCtx, p: PersonneResolue): Promise<void> {
  const nom = `${p.prenom} ${p.nom}`.trim();
  const matches = (await ctx.db
    .query("abo_abonnes_archive")
    .withIndex("by_nom_prenom_normalise", (q) =>
      q.eq("nom_prenom_normalise", normaliserNomPrenom(p.nom, p.prenom)),
    )
    .take(100))
    .filter((match) => abonnementEstValide(match.abonnement_valide));
  if (matches.length > 1) {
    throw new ConvexError({
      code: "ABO_N1_AMBIGU",
      message: `La correspondance N-1 de ${nom} est ambiguë. Contactez le staff avant de déposer une demande.`,
    });
  }
  if (matches.length === 1) {
    throw new ConvexError({
      code: "ABO_N1_REDIRECTION",
      message: `${nom} était déjà inscrit·e l'année dernière. Inscrivez-vous directement sur le site du club.`,
    });
  }
}

async function verifierSuppressionSite(ctx: MutationCtx, personne: Doc<"abo_personnes">) {
  let matches = personne.licence
    ? await ctx.db
        .query("abo_abonnes_scrap")
        .withIndex("by_licence", (q) => q.eq("licence", personne.licence!))
        .take(2)
    : await ctx.db
        .query("abo_abonnes_scrap")
        .withIndex("by_nom_prenom_normalise", (q) =>
          q.eq("nom_prenom_normalise", personne.nom_prenom_normalise),
        )
        .take(2);
  if (matches.length === 0 && personne.licence) {
    matches = await ctx.db
      .query("abo_abonnes_scrap")
      .withIndex("by_nom_prenom_normalise", (q) =>
        q.eq("nom_prenom_normalise", personne.nom_prenom_normalise),
      )
      .take(2);
  }
  if (matches.length === 1) {
    throw new ConvexError({
      code: "ABO_SUPPRESSION_INSCRIPTION_SITE",
      message: "Cette personne est déjà liée à une inscription sur le site du club. Retirez d’abord cette inscription sur le site, puis synchronisez.",
    });
  }
  if (matches.length > 1) {
    throw new ConvexError({
      code: "ABO_SUPPRESSION_MATCH_AMBIGU",
      message: "La correspondance avec les inscriptions du site est ambiguë. Vérifiez le site puis synchronisez avant toute suppression.",
    });
  }
}

// Applique les règles de vague à une saisie { nom?, prenom?, licence? } et
// renvoie l'identité résolue. Vague 2 : licence obligatoire, nom/prénom résolus
// depuis abo_eleves_en_cours (jamais renvoyés au client). Vague ≥ 3 : nom/prénom
// requis, licence facultative. Lève une ConvexError { code, message } sinon.
async function resoudrePersonne(
  ctx: MutationCtx,
  vague: number,
  saisie: { nom?: string; prenom?: string; licence?: string },
): Promise<PersonneResolue> {
  const raw = (saisie.licence ?? "").trim();
  if (raw.length > 32) {
    throw new ConvexError({
      code: "P0011",
      message: "Le numéro de licence est invalide : 12 chiffres attendus.",
    });
  }
  const licence = canoniserLicence(raw);

  if (raw !== "" && licence === null) {
    throw new ConvexError({
      code: "P0011",
      message: "Le numéro de licence est invalide : 12 chiffres attendus (commence en général par 7480).",
    });
  }

  if (vague === 2) {
    if (licence === null) {
      throw new ConvexError({
        code: "P0011",
        message:
          "Numéro de licence requis : en cette période, la demande est réservée aux élèves en cours d'escalade.",
      });
    }
    const eleve = await ctx.db
      .query("abo_eleves_en_cours")
      .withIndex("by_licence", (q) => q.eq("licence", licence))
      .first();
    if (!eleve || (!eleve.nom && !eleve.prenom)) {
      throw new ConvexError({
        code: "P0011",
        message: `La licence ${licence} n'est pas reconnue comme élève en cours d'escalade. Vous n'êtes pas inscrit en cours, ou votre inscription a été validée ce jour : réessayez dans 24 h.`,
      });
    }
    return {
      nom: eleve.nom ?? "",
      prenom: eleve.prenom ?? "",
      licence,
      licence_statut: "saisie",
    };
  }

  // Vague ≥ 3 : nom/prénom fournis, licence facultative.
  const nom = (saisie.nom ?? "").trim();
  const prenom = (saisie.prenom ?? "").trim();
  if (!nom || !prenom) {
    throw new ConvexError({
      code: "22023",
      message: "Nom et prénom sont requis pour chaque personne",
    });
  }
  return {
    nom,
    prenom,
    licence,
    licence_statut: licence !== null ? "saisie" : "inconnu",
  };
}

// Anti-doublon GLOBAL (toutes personnes, tous dossiers) AVANT insertion : par
// licence (si renseignée) OU par nom_prenom_normalise dans les deux orientations
// (nom↔prénom souvent intervertis). Lève ConvexError P0013 si la personne existe.
async function verifierAntiDoublon(
  ctx: MutationCtx,
  p: PersonneResolue,
): Promise<void> {
  if (p.licence !== null) {
    const lic = p.licence;
    const parLicence = await ctx.db
      .query("abo_personnes")
      .withIndex("by_licence", (q) => q.eq("licence", lic))
      .first();
    if (parLicence) throw doublon(p);
  }
  const norm = normaliserNomPrenom(p.nom, p.prenom);
  const normInv = normaliserNomPrenom(p.prenom, p.nom);
  for (const clef of normInv === norm ? [norm] : [norm, normInv]) {
    const match = await ctx.db
      .query("abo_personnes")
      .withIndex("by_nom_prenom_normalise", (q) =>
        q.eq("nom_prenom_normalise", clef),
      )
      .first();
    if (match) throw doublon(p);
  }
}

function doublon(p: PersonneResolue): ConvexError<{ code: string; message: string }> {
  const nomComplet = `${p.prenom} ${p.nom}`.trim();
  return new ConvexError({
    code: "P0013",
    message: `${nomComplet} a déjà fait une demande (une même personne ne peut s'inscrire qu'une seule fois).`,
  });
}

// Insère une personne résolue dans un dossier (valeurs par défaut des 8 étapes).
async function insererPersonne(
  ctx: MutationCtx,
  dossierId: Id<"abo_dossiers">,
  p: PersonneResolue,
  depot: MetadonneesDepot,
): Promise<Id<"abo_personnes">> {
  return await ctx.db.insert("abo_personnes", {
    dossier_id: dossierId,
    nom: p.nom,
    prenom: p.prenom,
    nom_prenom_normalise: normaliserNomPrenom(p.nom, p.prenom),
    licence: p.licence ?? undefined,
    licence_statut: p.licence_statut,
    etape_demande: true,
    etape_validation: "en_attente",
    etape_licence: false,
    etape_inscription_site: false,
    etape_photo: false,
    etape_paiement: false,
    etape_abonnement_valide: false,
    ...depot,
  });
}

const creerDemandeArgs = {
  commentaire: v.optional(v.string()),
  personnes: v.array(
    v.object({
      nom: v.optional(v.string()),
      prenom: v.optional(v.string()),
      licence: v.optional(v.string()),
    }),
  ),
};

// Transaction métier privée, appelée seulement après consommation durable de
// la limite N-1 par l'action publique ci-dessous.
export const creerDemandeInterne = internalMutation({
  args: creerDemandeArgs,
  returns: v.id("abo_dossiers"),
  handler: async (ctx, args) => {
    const identity = await requireAboIdentity(ctx);
    let emailCanonique: string;
    try {
      emailCanonique = canoniserEmailUnique(identity.email);
    } catch {
      throw new ConvexError({
        code: "AUTH_ABO_COMPTE_INVALIDE",
        message: "Impossible de traiter ce compte.",
      });
    }
    const compteFusionne = await ctx.db
      .query("abo_fusion_redirections_email")
      .withIndex("by_email_supprime", (q) => q.eq("email_supprime", emailCanonique))
      .first();
    if (compteFusionne) {
      throw new ConvexError({
        code: "AUTH_ABO_EMAIL_FUSIONNE",
        message: "Ce compte a été regroupé. Consultez le message envoyé par la commission escalade.",
      });
    }
    await limiterEcritureDemande(ctx, identity.userId);

    if (args.personnes.length === 0 || args.personnes.length > MAX_PERSONNES_PAR_DOSSIER) {
      throw new ConvexError({
        code: "22023",
        message: "Une demande doit contenir entre 1 et 10 personnes.",
      });
    }
    if ((args.commentaire ?? "").trim().length > MAX_LONGUEUR_COMMENTAIRE) {
      throw new ConvexError({ code: "22023", message: "Le commentaire est limité à 2 000 caractères." });
    }
    for (const saisie of args.personnes) verifierLongueursSaisie(saisie);

    const vague = await vagueCourante(ctx, Date.now());
    if (vague < 2) {
      throw new ConvexError({
        code: "P0010",
        message: "La demande de dispo n'est pas encore ouverte.",
      });
    }

    // 1 dossier par compte (owner). L'unicité par email est portée ici.
    const existant = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .first();
    if (existant) {
      throw new ConvexError({
        code: "23505",
        message: "Une demande existe déjà pour votre compte.",
      });
    }

    const depot = contexteDepot(vague);
    const resolues: PersonneResolue[] = [];
    for (const saisie of args.personnes) {
      const p = await resoudrePersonne(ctx, vague, saisie);
      await verifierN1(ctx, p);
      await verifierAntiDoublon(ctx, p);
      if (
        resolues.some(
          (deja) =>
            (p.licence !== null && p.licence === deja.licence) ||
            normaliserNomPrenom(p.nom, p.prenom) ===
              normaliserNomPrenom(deja.nom, deja.prenom),
        )
      ) {
        throw doublon(p);
      }
      resolues.push(p);
    }

    const dossierId = await ctx.db.insert("abo_dossiers", {
      email: identity.email,
      owner_id: identity.userId,
      statut_dossier: "nouvelle_demande",
      date_soumission: new Date().toISOString(),
      commentaire: (args.commentaire ?? "").trim() || undefined,
    });

    // Insertion en boucle : les itérations précédentes sont visibles pour
    // l'anti-doublon intra-demande (les writes sont vus dans la transaction).
    for (const p of resolues) {
      await insererPersonne(ctx, dossierId, p, depot);
    }

    // Accusé de réception (boîte abo, anti-doublon abo_email_log).
    await ctx.scheduler.runAfter(0, internal.abo.emails.envoyerEmailAbo, {
      dossierId,
      typeEmail: "accuse",
    });

    await programmerRafraichissementCompteurPublic(ctx);

    return dossierId;
  },
});

// ── creerDemande : dossier + personnes, atomique, gatée par vague ────
// L'action sépare volontairement la consommation du quota de la transaction
// métier : une redirection N-1 fait échouer la seconde sans annuler le quota.
export const creerDemande = authenticatedAction({
  args: creerDemandeArgs,
  returns: v.id("abo_dossiers"),
  handler: async (ctx, args) => {
    if (
      args.personnes.length === 0 ||
      args.personnes.length > MAX_PERSONNES_PAR_DOSSIER
    ) {
      throw new ConvexError({
        code: "22023",
        message: "Une demande doit contenir entre 1 et 10 personnes.",
      });
    }
    await limiterTentativesN1(ctx, ctx.userId, args.personnes.length);
    const dossierId: Id<"abo_dossiers"> = await ctx.runMutation(
      internal.abo.demandes.creerDemandeInterne,
      args,
    );
    return dossierId;
  },
});

// ── ajouterPersonne : complète SON dossier depuis le suivi ───────────
const ajouterPersonneArgs = {
  nom: v.optional(v.string()),
  prenom: v.optional(v.string()),
  licence: v.optional(v.string()),
};

export const ajouterPersonneInterne = internalMutation({
  args: ajouterPersonneArgs,
  returns: v.id("abo_personnes"),
  handler: async (ctx, args) => {
    const identity = await requireAboIdentity(ctx);
    await limiterEcritureDemande(ctx, identity.userId);
    verifierLongueursSaisie(args);
    const dossier = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .first();
    if (!dossier) {
      throw new ConvexError({ code: "P0002", message: "Aucun dossier pour ce compte." });
    }

    const personnesExistantes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .take(MAX_PERSONNES_PAR_DOSSIER);
    if (personnesExistantes.length >= MAX_PERSONNES_PAR_DOSSIER) {
      throw new ConvexError({
        code: "ABO_MAX_PERSONNES",
        message: "Un dossier est limité à 10 personnes.",
      });
    }

    const vague = await vagueCourante(ctx, Date.now());
    if (vague < 2) {
      throw new ConvexError({
        code: "P0010",
        message: "La demande de dispo n'est pas ouverte.",
      });
    }

    const depot = contexteDepot(vague);
    const p = await resoudrePersonne(ctx, vague, args);
    await verifierN1(ctx, p);
    await verifierAntiDoublon(ctx, p);
    const personneId = await insererPersonne(ctx, dossier._id, p, depot);
    // Une personne ajoutée commence toujours « en attente » : le dossier doit
    // donc redevenir visible dans la file des nouvelles demandes, même si les
    // personnes déjà présentes ont toutes reçu une décision.
    await appliquerRollup(ctx, dossier);
    await programmerRafraichissementCompteurPublic(ctx);
    return personneId;
  },
});

export const ajouterPersonne = authenticatedAction({
  args: ajouterPersonneArgs,
  returns: v.id("abo_personnes"),
  handler: async (ctx, args) => {
    await limiterTentativesN1(ctx, ctx.userId, 1);
    const personneId: Id<"abo_personnes"> = await ctx.runMutation(
      internal.abo.demandes.ajouterPersonneInterne,
      args,
    );
    return personneId;
  },
});

// ── supprimerPersonne : retire UNE personne (archive + purge dossier vide) ──
export const supprimerPersonne = authenticatedMutation({
  args: { personneId: v.id("abo_personnes") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const identity = await requireAboIdentity(ctx);
    await limiterEcritureDemande(ctx, identity.userId);
    const personne = await ctx.db.get(args.personneId);
    if (!personne) {
      throw new ConvexError({
        code: "P0002",
        message: "Personne introuvable dans votre demande.",
      });
    }
    const dossier = await ctx.db.get(personne.dossier_id);
    if (!dossier || dossier.owner_id !== identity.userId) {
      throw new ConvexError({
        code: "P0002",
        message: "Personne introuvable dans votre demande.",
      });
    }

    await verifierSuppressionSite(ctx, personne);

    // Archive « Prénom Nom — supprimée le … ».
    await ctx.db.insert("abo_demandes_supprimees", {
      email: dossier.email,
      owner_id: identity.userId,
      personnes: `${personne.prenom} ${personne.nom}`.trim(),
      supprime_le: new Date().toISOString(),
    });

    // Purge les réservations de test de la personne (cascade).
    await supprimerReservationsPersonne(ctx, personne._id);
    await ctx.db.delete(personne._id);

    const restantes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .first();
    if (!restantes) {
      // Dossier vide : cascade messages / email_log puis suppression. Email libéré.
      await purgerDossier(ctx, dossier._id);
      await programmerRafraichissementCompteurPublic(ctx);
      return true;
    }
    await appliquerRollup(ctx, dossier);
    await programmerRafraichissementCompteurPublic(ctx);
    return false;
  },
});

// Supprime toutes les réservations de test d'une personne.
async function supprimerReservationsPersonne(
  ctx: MutationCtx,
  personneId: Id<"abo_personnes">,
): Promise<void> {
  const resas = await ctx.db
    .query("abo_test_reservations")
    .withIndex("by_personne", (q) => q.eq("personne_id", personneId))
    .collect();
  for (const r of resas) await ctx.db.delete(r._id);
}

// Supprime un dossier vide et ses dépendances (messages, journal d'emails).
async function purgerDossier(
  ctx: MutationCtx,
  dossierId: Id<"abo_dossiers">,
): Promise<void> {
  const messages = await ctx.db
    .query("abo_messages")
    .withIndex("by_dossier", (q) => q.eq("dossier_id", dossierId))
    .collect();
  for (const m of messages) await ctx.db.delete(m._id);
  const logs = await ctx.db
    .query("abo_email_log")
    .withIndex("by_dossier", (q) => q.eq("dossier_id", dossierId))
    .collect();
  for (const l of logs) await ctx.db.delete(l._id);
  await ctx.db.delete(dossierId);
}

// ── getMonDossier : dossier + personnes du caller (owner) ────────────
export const getMonDossier = authenticatedQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("abo_dossiers"),
      statut_dossier: statutDossierValidator,
      commentaire: v.union(v.string(), v.null()),
      date_soumission: v.string(),
      personnes: v.array(personneVueValidator),
    }),
  ),
  handler: async (ctx) => {
    const identity = await requireAboIdentity(ctx);
    const dossier = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .first();
    if (!dossier) return null;
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .collect();
    return {
      id: dossier._id,
      statut_dossier: dossier.statut_dossier,
      commentaire: dossier.commentaire ?? null,
      date_soumission: dossier.date_soumission,
      personnes: personnes.map(personneVue),
    };
  },
});

// Projection d'une personne pour le front (id lisible + champs d'étapes).
export function personneVue(p: Doc<"abo_personnes">) {
  return {
    id: p._id,
    nom: p.nom,
    prenom: p.prenom,
    age: p.age ?? null,
    nom_prenom_normalise: p.nom_prenom_normalise,
    licence: p.licence ?? null,
    licence_statut: p.licence_statut,
    etape_demande: p.etape_demande,
    etape_validation: p.etape_validation,
    etape_licence: p.etape_licence,
    etape_test_autonomie: p.etape_test_autonomie ?? null,
    etape_inscription_site: p.etape_inscription_site,
    etape_photo: p.etape_photo,
    etape_paiement: p.etape_paiement,
    etape_abonnement_valide: p.etape_abonnement_valide,
    vague_depot: p.vague_depot ?? "historique",
    deposee_le: p.deposee_le ?? new Date(p._creationTime).toISOString(),
  };
}

// ── getMesSuppressions : historique des retraits du caller ───────────
export const getMesSuppressions = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAboIdentity(ctx);
    const rows = await ctx.db
      .query("abo_demandes_supprimees")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .order("desc")
      .take(50);
    return rows.map((r) => ({
      email: r.email,
      personnes: r.personnes ?? null,
      supprime_le: r.supprime_le,
    }));
  },
});

// ── monSuivi : vérifs LIVE des étapes de finalisation (owner) ────────
// Recalculées à chaque affichage depuis abo_licences + abo_abonnes_scrap
// (indépendamment du batch de matching). Matching licence-first, repli nom/prénom.
export async function calculerSuiviPersonnes(
  ctx: Parameters<typeof requireAboIdentity>[0],
  personnes: Doc<"abo_personnes">[],
) {
  const out = [];
  for (const p of personnes) {
    // Ligne du scrap correspondante (licence d'abord, sinon nom/prénom).
    let scrap: Doc<"abo_abonnes_scrap"> | null = null;
    if (p.licence) {
      scrap = await ctx.db
        .query("abo_abonnes_scrap")
        .withIndex("by_licence", (q) => q.eq("licence", p.licence))
        .first();
    }
    if (!scrap && p.nom_prenom_normalise) {
      scrap = await ctx.db
        .query("abo_abonnes_scrap")
        .withIndex("by_nom_prenom_normalise", (q) =>
          q.eq("nom_prenom_normalise", p.nom_prenom_normalise),
        )
        .first();
    }

    // Étape 1 : licence dans l'annuaire (par n°) OU adhésion OK au scrap.
    let licenceAnnuaire = false;
    if (p.licence) {
      const l = await ctx.db
        .query("abo_licences")
        .withIndex("by_licence", (q) => q.eq("licence", p.licence!))
        .first();
      licenceAnnuaire = l !== null;
    }
    const licence_ok = licenceAnnuaire || scrap?.adhesion === "OK";

    // Le règlement n'est reconnu que par la licence exacte. Aucun repli nom
    // / prénom n'est autorisé sur cette preuve validée manuellement.
    const licenceReglement = p.licence;
    const licenceConfirmee =
      p.licence_statut === "annuaire_auto" ||
      p.licence_statut === "annuaire_valide";
    const reglementSigne = licenceConfirmee && licenceReglement
      ? await ctx.db
          .query("abo_reglements_signes")
          .withIndex("by_version_reglement_and_licence", (q) =>
            q
              .eq("version_reglement", REGLEMENT_VERSION)
              .eq("licence", licenceReglement),
          )
          .first()
      : null;

    out.push({
      personne_id: p._id,
      licence_ok,
      inscription_ok: scrap !== null,
      paiement_ok: scrap ? abonnementEstValide(scrap.abonnement_valide) : false,
      test_autonomie: mapAutonomie(scrap?.autonomie),
      reglement_signe: reglementSigne !== null,
      age: scrap?.age ?? p.age ?? null,
    });
  }
  return out;
}

export const monSuivi = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    personne_id: v.id("abo_personnes"),
    licence_ok: v.boolean(),
    inscription_ok: v.boolean(),
    paiement_ok: v.boolean(),
    test_autonomie: v.union(
      v.literal("valide"),
      v.literal("non_requis"),
      v.literal("requis"),
      v.null(),
    ),
    reglement_signe: v.boolean(),
    age: v.union(v.number(), v.null()),
  })),
  handler: async (ctx) => {
    const identity = await requireAboIdentity(ctx);
    const dossier = await ctx.db
      .query("abo_dossiers")
      .withIndex("by_owner", (q) => q.eq("owner_id", identity.userId))
      .first();
    if (!dossier) return [];
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .collect();

    return await calculerSuiviPersonnes(ctx, personnes);
  },
});

// Mapping du libellé « autonomie » du scrap → état de l'étape test (ou null).
function mapAutonomie(v?: string): "valide" | "non_requis" | "requis" | null {
  switch (v) {
    case "OK":
      return "valide";
    case "Trop jeune":
      return "non_requis";
    case "Doit passer le test":
    case "Recherche du test en cours":
      return "requis";
    default:
      return null;
  }
}

// ── getDossiersAdmin : tous les dossiers + personnes (admin) ─────────
export const getDossiersAdmin = authenticatedQuery({
  args: {},
  returns: v.array(v.object({
    id: v.id("abo_dossiers"),
    email: v.string(),
    statut_dossier: statutDossierValidator,
    date_soumission: v.string(),
    date_validation: v.union(v.string(), v.null()),
    commentaire: v.union(v.string(), v.null()),
    personnes: v.array(personneVueValidator),
  })),
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const dossiers = await ctx.db.query("abo_dossiers").order("desc").take(500);
    const out = [];
    for (const d of dossiers) {
      const personnes = await ctx.db
        .query("abo_personnes")
        .withIndex("by_dossier", (q) => q.eq("dossier_id", d._id))
        .collect();
      out.push({
        id: d._id,
        email: d.email,
        statut_dossier: d.statut_dossier,
        date_soumission: d.date_soumission,
        date_validation: d.date_validation ?? null,
        commentaire: d.commentaire ?? null,
        personnes: personnes.map(personneVue),
      });
    }
    // Tri par date de soumission décroissante (fidèle à getDossiersAdmin).
    out.sort((a, b) => (a.date_soumission < b.date_soumission ? 1 : -1));
    return out;
  },
});

// ── getSuppressions : historique global (admin) ─────────────────────
export const getSuppressions = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    await requireAboAdmin(ctx);
    const rows = await ctx.db
      .query("abo_demandes_supprimees")
      .order("desc")
      .take(200);
    return rows.map((r) => ({
      email: r.email,
      personnes: r.personnes ?? null,
      supprime_le: r.supprime_le,
    }));
  },
});

// Rollup du statut_dossier à partir de l'ensemble des personnes (règle de priorité).
function rollupStatut(
  personnes: Doc<"abo_personnes">[],
): Doc<"abo_dossiers">["statut_dossier"] {
  const etats = personnes.map((p) => p.etape_validation);
  if (etats.some((e) => e === "en_attente")) return "nouvelle_demande";
  if (etats.some((e) => e === "validee")) return "validee";
  if (etats.some((e) => e === "liste_attente")) return "liste_attente";
  return "refusee";
}

// Applique le rollup + pose date_validation à la 1re bascule en « validee ».
async function appliquerRollup(
  ctx: MutationCtx,
  dossier: Doc<"abo_dossiers">,
): Promise<void> {
  const personnes = await ctx.db
    .query("abo_personnes")
    .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
    .collect();
  const statut = rollupStatut(personnes);
  const dateValidation =
    statut === "validee" && !dossier.date_validation
      ? new Date().toISOString()
      : dossier.date_validation;
  if (
    dossier.statut_dossier !== statut ||
    dossier.date_validation !== dateValidation
  ) {
    await ctx.db.patch(dossier._id, {
      statut_dossier: statut,
      date_validation: dateValidation,
    });
  }
  await planifierEmailStatut(ctx, dossier._id, dossier.statut_dossier, statut);
}

// ── validerPersonne : décision admin PAR PERSONNE + rollup ──────────
export const validerPersonne = authenticatedMutation({
  args: {
    personneId: v.id("abo_personnes"),
    decision: decisionValidator,
    autoriserDepassementPlafond: v.optional(v.boolean()),
  },
  returns: resultatDecisionPlafondValidator,
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const personne = await ctx.db.get(args.personneId);
    if (!personne) {
      throw new ConvexError({ code: "P0002", message: "Personne introuvable" });
    }
    const resultat = await deciderAvecPlafond(
      ctx,
      [personne],
      args.decision,
      args.autoriserDepassementPlafond,
    );
    await ctx.db.patch(personne._id, { etape_validation: resultat.decisionAppliquee });
    const dossier = await ctx.db.get(personne.dossier_id);
    if (dossier) await appliquerRollup(ctx, dossier);
    await programmerRafraichissementCompteurPublic(ctx);
    return resultat;
  },
});

// ── validerDossier : décision admin globale (compat) ────────────────
export const validerDossier = authenticatedMutation({
  args: {
    dossierId: v.id("abo_dossiers"),
    decision: decisionValidator,
    autoriserDepassementPlafond: v.optional(v.boolean()),
  },
  returns: resultatDecisionPlafondValidator,
  handler: async (ctx, args) => {
    await requireAboAdmin(ctx);
    const dossier = await ctx.db.get(args.dossierId);
    if (!dossier) {
      throw new ConvexError({ code: "P0002", message: "Dossier introuvable" });
    }
    const personnes = await ctx.db
      .query("abo_personnes")
      .withIndex("by_dossier", (q) => q.eq("dossier_id", dossier._id))
      .collect();
    const resultat = await deciderAvecPlafond(
      ctx,
      personnes,
      args.decision,
      args.autoriserDepassementPlafond,
      true,
    );
    for (const p of personnes) {
      // Au dépassement, une validation déjà acquise ne peut pas être retirée
      // par la décision globale : seules les nouvelles validations attendent.
      const decisionPersonne =
        resultat.decisionAppliquee === "liste_attente" &&
        args.decision === "validee" &&
        p.etape_validation === "validee"
          ? "validee"
          : resultat.decisionAppliquee;
      await ctx.db.patch(p._id, { etape_validation: decisionPersonne });
    }
    // Le rollup reste la source de vérité du statut du dossier et de son email
    // transactionnel historique ; il ne prétend pas notifier chaque personne.
    await appliquerRollup(ctx, dossier);
    await programmerRafraichissementCompteurPublic(ctx);
    return resultat;
  },
});

// Type de la projection personne, utile aux modules voisins.
export type PersonneVue = ReturnType<typeof personneVue>;
