import { query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { authenticatedQuery, authenticatedMutation } from "./customFunctions";
import { getUserSettings, requireAdmin, TILES } from "./access";
import { champsModifies } from "./dbUtils";
import { canoniserEmailUnique } from "./emailValidation";
import { parisWallToUtcMs } from "./abo/config";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const MAX_USERS_FALLBACK_EMAIL = 2_000;
const MAX_STAFF_USERS = 500;

async function exigerMembreStaff(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"userSettings">> {
  const settings = await ctx.db
    .query("userSettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();

  if (!settings) {
    throw new ConvexError({
      code: "USER_NOT_STAFF",
      message: "Ce compte n'est pas un membre du staff.",
    });
  }

  return settings;
}

export async function getAboStaffActifsIds(
  ctx: QueryCtx | MutationCtx,
  userIds: readonly Id<"users">[],
): Promise<Set<Id<"users">>> {
  const idsUniques = [...new Set(userIds)];
  const resultats = await Promise.all(idsUniques.map(async (userId) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    return settings?.allowedTiles.includes("abonnements") ? userId : null;
  }));

  return new Set(resultats.filter((userId) => userId !== null));
}

export async function getAboStaffActifsParId(
  ctx: QueryCtx | MutationCtx,
  userIds: readonly Id<"users">[],
): Promise<Map<Id<"users">, Doc<"users">>> {
  const idsActifs = await getAboStaffActifsIds(ctx, userIds);
  const resultats = await Promise.all([...idsActifs].map(async (userId) => {
    const user = await ctx.db.get(userId);
    return user ? ([userId, user] as const) : null;
  }));

  return new Map(resultats.filter((resultat) => resultat !== null));
}

function tableauxStringEgaux(
  gauche: readonly string[],
  droite: readonly string[],
): boolean {
  const valeursGauche = new Set(gauche);
  const valeursDroite = new Set(droite);
  return (
    valeursGauche.size === valeursDroite.size &&
    [...valeursGauche].every((valeur) => valeursDroite.has(valeur))
  );
}

async function exigerAucunCreneauAboFutur(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  // Lecture ciblée par propriétaire : aucun index composite admin/date
  // n'existe, et la garde doit rester exacte avant une révocation d'accès.
  const creneaux = await ctx.db
    .query("abo_test_creneaux")
    .withIndex("by_admin", (q) => q.eq("admin_id", userId))
    .collect();
  const maintenant = Date.now();
  const aUnCreneauFutur = creneaux.some((creneau) => {
    const debut = parisWallToUtcMs(
      `${creneau.date_jour}T${creneau.heure_debut}`,
    );
    return debut !== null && debut > maintenant;
  });
  if (aUnCreneauFutur) {
    throw new ConvexError({
      code: "ABO_TEST_CRENEAU_FUTUR",
      message: "Ce membre possède encore un créneau futur de test d'autonomie. Il doit d'abord le retirer.",
    });
  }
}

function emailCanoniqueSiValide(email: unknown): string | null {
  if (typeof email !== "string") return null;
  try {
    return canoniserEmailUnique(email);
  } catch {
    return null;
  }
}

const dashboardTileValidator = v.union(
  v.literal("compta"),
  v.literal("paiements"),
  v.literal("budget"),
  v.literal("abonnements"),
  v.literal("licences_cours"),
  v.literal("contacts_cours"),
  v.literal("remboursements_eleves"),
);

const dashboardColorValidator = v.union(
  v.literal("bg-info"),
  v.literal("bg-success"),
  v.literal("bg-warning"),
  v.literal("bg-primary"),
  v.literal("bg-danger"),
  v.literal("bg-orange"),
  v.literal("bg-pink"),
  v.literal("bg-purple"),
  v.literal("bg-lime"),
);

const dashboardTileMetadataValidator = v.object({
  id: dashboardTileValidator,
  color: dashboardColorValidator,
  label: v.optional(v.string()),
  description: v.optional(v.string()),
});

type DashboardColor =
  | "bg-info" | "bg-success" | "bg-warning" | "bg-primary" | "bg-danger"
  | "bg-orange" | "bg-pink" | "bg-purple" | "bg-lime";

type DashboardTile = {
  id: (typeof TILES)[number];
  color: DashboardColor;
  label?: string;
  description?: string;
};

/**
 * Budget s'appuie sur les données comptables : l'accès Budget implique donc
 * toujours l'accès Compta. Les autres identifiants (y compris d'éventuelles
 * tuiles ajoutées avant une mise à jour du client) sont conservés tels quels.
 */
function ensureBudgetIncludesCompta(allowedTiles: readonly string[]): string[] {
  if (
    allowedTiles.includes("budget") &&
    !allowedTiles.includes("compta")
  ) {
    return [...allowedTiles, "compta"];
  }

  return [...allowedTiles];
}

function optionalTrimmedText(value: string | undefined, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maximum) throw new ConvexError(`${field} ne peut pas dépasser ${maximum} caractères.`);
  return trimmed;
}

function normalizeDashboardTiles(tiles: readonly DashboardTile[]) {
  return tiles.map((tile) => {
    const label = optionalTrimmedText(tile.label, "Le nom de la tuile", 80);
    const description = optionalTrimmedText(tile.description, "La description", 240);
    return {
      id: tile.id,
      color: tile.color,
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
    };
  });
}

function hasEachTileExactlyOnce(tileIds: readonly string[]): boolean {
  return (
    tileIds.length === TILES.length &&
    new Set(tileIds).size === TILES.length &&
    TILES.every((tile) => tileIds.includes(tile))
  );
}

function dashboardTilesAreEqual(
  saved: readonly DashboardTile[],
  submitted: readonly DashboardTile[],
): boolean {
  return (
    saved.length === submitted.length &&
    saved.every(
      (tile, index) =>
        tile.id === submitted[index]?.id && tile.color === submitted[index]?.color && tile.label === submitted[index]?.label && tile.description === submitted[index]?.description,
    )
  );
}

// PUBLIC: renvoie uniquement l'utilisateur connecté (null sinon) — sans risque.
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    return await ctx.db.get(userId);
  },
});

export const listUsers = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    // Expose tous les emails/accès : réservé à la page Configurations (admin).
    await requireAdmin(ctx, ctx.userId);

    // IO-BOUNDED: la page Configurations ne gère que le staff du club ; le
    // plafond détecte une croissance anormale sans parcourir les comptes
    // publics Abonnements stockés dans la table Convex Auth partagée.
    const userSettings = await ctx.db
      .query("userSettings")
      .take(MAX_STAFF_USERS + 1);
    if (userSettings.length > MAX_STAFF_USERS) {
      throw new ConvexError(
        "La liste du staff dépasse la limite prévue. Une pagination est nécessaire.",
      );
    }

    const staff = await Promise.all(userSettings.map(async (settings) => {
      const user = await ctx.db.get(settings.userId);
      return user ? { ...user, settings } : null;
    }));

    return staff.filter((user) => user !== null);
  },
});

export const getCurrentUserSettings = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.userId))
      .first();
    return settings || {
      allowedTiles: [] as string[],
      role: "user",
      canResetAboSeason: false,
      canManageAboConfiguration: false,
    };
  },
});

export const addUser = authenticatedMutation({
  args: { email: v.string(), name: v.string() },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError("Le nom est obligatoire.");
    }
    const email = canoniserEmailUnique(args.email);

    const existingUser = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();

    if (existingUser) {
      throw new ConvexError("Un utilisateur avec cet email existe déjà.");
    }

    // Compatibilité avant le backfill : l'index exact ne voit pas les emails
    // historiques avec casse ou espaces. La lecture de secours reste bornée et
    // ne fusionne jamais automatiquement des comptes administrés.
    const utilisateurs = await ctx.db.query("users").take(MAX_USERS_FALLBACK_EMAIL + 1);
    if (utilisateurs.length > MAX_USERS_FALLBACK_EMAIL) {
      throw new ConvexError(
        "Impossible de vérifier les anciens emails : migration requise avant l'ajout.",
      );
    }
    if (utilisateurs.some((user) => emailCanoniqueSiValide(user.email) === email)) {
      throw new ConvexError("Un utilisateur avec cet email existe déjà.");
    }

    const newUserId = await ctx.db.insert("users", {
      email,
      name
    });
    
    await ctx.db.insert("userSettings", {
      userId: newUserId,
      allowedTiles: ensureBudgetIncludesCompta(["compta", "paiements", "budget"]),
      role: "user",
      canResetAboSeason: false,
      canManageAboConfiguration: false,
    });
    
    return newUserId;
  },
});

export const removeUser = authenticatedMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);
    const settings = await exigerMembreStaff(ctx, args.userId);
    await exigerAucunCreneauAboFutur(ctx, args.userId);

    await ctx.db.delete(settings._id);
    await ctx.db.delete(args.userId);
  },
});

// La lecture est ouverte à tout le staff authentifié : la configuration pilote
// l'affichage de leur tableau de bord. Les modifications restent réservées aux
// administrateurs ci-dessous.
export const getDashboardConfiguration = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await getUserSettings(ctx, ctx.userId))) {
      throw new ConvexError("Accès refusé : compte staff requis.");
    }

    return await ctx.db
      .query("dashboardConfiguration")
      .withIndex("by_cle", (q) => q.eq("cle", "global"))
      .unique();
  },
});

export const updateDashboardConfiguration = authenticatedMutation({
  args: {
    tiles: v.array(dashboardTileMetadataValidator),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);

    if (!hasEachTileExactlyOnce(args.tiles.map((tile) => tile.id))) {
      throw new ConvexError(
        "La configuration doit contenir chaque tuile exactement une fois.",
      );
    }

    const tiles = normalizeDashboardTiles(args.tiles as DashboardTile[]);
    const existing = await ctx.db
      .query("dashboardConfiguration")
      .withIndex("by_cle", (q) => q.eq("cle", "global"))
      .unique();
    const configuration = {
      cle: "global" as const,
      tiles,
    };

    if (!existing) {
      return await ctx.db.insert("dashboardConfiguration", configuration);
    }

    if (
      champsModifies(existing, { cle: configuration.cle }) ||
      !dashboardTilesAreEqual(existing.tiles, configuration.tiles)
    ) {
      await ctx.db.patch(existing._id, configuration);
    }

    return existing._id;
  },
});

export const updateUserSettings = authenticatedMutation({
  args: {
    userId: v.id("users"),
    allowedTiles: v.array(v.string()),
    role: v.string(),
    name: v.string(),
    canManageAboConfiguration: v.optional(v.boolean()),
    // Compatibilité courte avec un onglet Configurations encore en cache après
    // déploiement : les nouveaux clients envoient uniquement le nouveau droit.
    canResetAboSeason: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, ctx.userId);
    const settings = await exigerMembreStaff(ctx, args.userId);

    const name = args.name.trim();
    if (!name) {
      throw new Error("Le nom est obligatoire.");
    }

    const allowedTiles = ensureBudgetIncludesCompta(args.allowedTiles);
    // Le droit de configuration est réservé au staff qui gère réellement les
    // Abonnements, sans exiger le rôle global admin du titulaire.
    const canManageAboConfiguration =
      (args.canManageAboConfiguration ?? args.canResetAboSeason ?? false)
      && allowedTiles.includes("abonnements");

    const retireTuileAbonnements =
      settings.allowedTiles.includes("abonnements") &&
      !allowedTiles.includes("abonnements");
    if (retireTuileAbonnements) {
      await exigerAucunCreneauAboFutur(ctx, args.userId);
    }

    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new ConvexError("Utilisateur introuvable.");
    }
    if (champsModifies(user, { name })) {
      await ctx.db.patch(args.userId, { name });
    }
      
    const nouvellesSettings = {
      allowedTiles,
      role: args.role,
      canManageAboConfiguration,
      // Dès qu'une fiche est enregistrée, la décision est portée uniquement
      // par le nouveau droit : une ancienne autorisation ne peut pas survivre
      // à une révocation explicite.
      canResetAboSeason: false,
    };
    if (
      !tableauxStringEgaux(settings.allowedTiles, allowedTiles) ||
      champsModifies(settings, nouvellesSettings, ["allowedTiles"])
    ) {
      await ctx.db.patch(settings._id, nouvellesSettings);
    }
  },
});
