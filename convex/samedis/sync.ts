import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "../customFunctions";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { champsModifies } from "../dbUtils";
import {
  enumererSamedis,
  erreur,
  MAX_SAMEDIS_PAR_SAISON,
  tableauxEgaux,
  texteCourt,
  verifierSaison,
} from "./lib";
import { creerNotification } from "./notifications";

const SYNCHRO_TTL_MS = 60 * 60 * 1_000;
const SYNCHRO_VERROU_MS = 30 * 1_000;

const sourceValidator = v.union(v.literal("ferie"), v.literal("vacances"));
const blocageValidator = v.object({
  date: v.string(),
  motifs: v.array(v.string()),
  sources: v.array(sourceValidator),
});

export const reserverSync = internalMutation({
  args: {
    saison: v.string(),
    acteurUserId: v.id("users"),
    maintenant: v.number(),
    actualiserMemeSiRecent: v.boolean(),
  },
  returns: v.union(
    v.object({ lancee: v.literal(false) }),
    v.object({
      lancee: v.literal(true),
      dateDebut: v.string(),
      dateFin: v.string(),
      startedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const configuration = await ctx.db
      .query("samedis_configurations")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .unique();
    if (!configuration) throw erreur("SAMEDIS_CONFIGURATION_ABSENTE", "Configurez d'abord la saison.");
    if (configuration.derniereSynchronisation !== undefined) {
      const age = args.maintenant - configuration.derniereSynchronisation;
      const delaiMinimal = args.actualiserMemeSiRecent
        ? SYNCHRO_VERROU_MS
        : SYNCHRO_TTL_MS;
      if (age < delaiMinimal) return { lancee: false as const };
    }
    // Le tampon sert aussi de verrou partagé. Les actions concurrentes entrent
    // en conflit OCC puis relisent ce verrou avant tout appel externe.
    await ctx.db.patch(configuration._id, {
      derniereSynchronisation: args.maintenant,
      erreurSynchronisation: undefined,
    });
    return {
      lancee: true as const,
      dateDebut: configuration.dateDebut,
      dateFin: configuration.dateFin,
      startedAt: args.maintenant,
    };
  },
});

export const appliquerSync = internalMutation({
  args: {
    saison: v.string(),
    acteurUserId: v.id("users"),
    startedAt: v.number(),
    blocages: v.array(blocageValidator),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    if (args.blocages.length > MAX_SAMEDIS_PAR_SAISON) {
      throw erreur("SAMEDIS_VOLUME_INVALIDE", "Trop de dates reçues de l'API officielle.");
    }
    const configuration = await ctx.db
      .query("samedis_configurations")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .unique();
    if (!configuration || configuration.derniereSynchronisation !== args.startedAt) {
      throw erreur("SAMEDIS_SYNCHRO_OBSOLETE", "Cette synchronisation a été remplacée par une plus récente.");
    }
    const creneaux = await ctx.db
      .query("samedis_creneaux")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .take(MAX_SAMEDIS_PAR_SAISON + 1);
    if (creneaux.length > MAX_SAMEDIS_PAR_SAISON) {
      throw erreur("SAMEDIS_VOLUME_DEPASSE", "La saison contient trop de samedis.");
    }
    const reservations = await ctx.db
      .query("samedis_reservations")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .take(MAX_SAMEDIS_PAR_SAISON + 1);
    if (reservations.length > MAX_SAMEDIS_PAR_SAISON) {
      throw erreur("SAMEDIS_VOLUME_DEPASSE", "La saison contient trop de réservations.");
    }
    const reservationParCreneau = new Map(
      reservations.map((reservation) => [reservation.creneauId, reservation]),
    );
    const parDate = new Map(args.blocages.map((blocage) => [blocage.date, blocage]));
    let modifications = 0;
    let anomalies = 0;
    for (const creneau of creneaux) {
      const blocage = parDate.get(creneau.date) ?? { motifs: [], sources: [] };
      const motifsManuels = creneau.motifsBlocage.filter(
        (_motif, index) => creneau.sourcesBlocage[index] === "manuel",
      );
      const sourcesManuelles = creneau.sourcesBlocage.filter((source) => source === "manuel");
      const nouveauxMotifs = [...blocage.motifs, ...motifsManuels];
      const nouvellesSources = [...blocage.sources, ...sourcesManuelles];
      const estBloque = blocage.sources.length > 0 || sourcesManuelles.length > 0;
      const patch = {
        motifsBlocage: tableauxEgaux(creneau.motifsBlocage, nouveauxMotifs)
          ? creneau.motifsBlocage
          : nouveauxMotifs,
        sourcesBlocage: tableauxEgaux(creneau.sourcesBlocage, nouvellesSources)
          ? creneau.sourcesBlocage
          : nouvellesSources,
        estBloque,
        updatedAt: Date.now(),
        updatedBy: args.acteurUserId,
      };
      if (champsModifies(creneau, patch, ["updatedAt", "updatedBy"])) {
        await ctx.db.patch(creneau._id, patch);
        modifications += 1;
      }
      const reservation = reservationParCreneau.get(creneau._id);
      if (estBloque && reservation && !reservation.forcee) anomalies += 1;
    }
    const configPatch = {
      statutSynchronisation: "ok" as const,
      erreurSynchronisation: undefined,
    };
    if (champsModifies(configuration, configPatch)) {
      await ctx.db.patch(configuration._id, configPatch);
    }
    await creerNotification(ctx, {
      saison: args.saison,
      typeModification: "calendrier_synchronise",
      acteurUserId: args.acteurUserId,
      resume:
        `Calendrier officiel synchronisé : ${modifications} samedi(s) mis à jour, ` +
        `${anomalies} réservation(s) à régulariser.`,
    });
    return modifications;
  },
});

export const marquerEchec = internalMutation({
  args: {
    saison: v.string(),
    startedAt: v.number(),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const configuration = await ctx.db
      .query("samedis_configurations")
      .withIndex("by_saison", (q) => q.eq("saison", args.saison))
      .unique();
    if (!configuration || configuration.derniereSynchronisation !== args.startedAt) return null;
    const patch = {
      statutSynchronisation: "erreur" as const,
      erreurSynchronisation: args.message.slice(0, 500),
    };
    if (champsModifies(configuration, patch)) await ctx.db.patch(configuration._id, patch);
    return null;
  },
});

interface VacancesRecord {
  start_date: string;
  end_date: string;
  description?: string;
}

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
}

async function chargerJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`API officielle indisponible (${response.status}).`);
  return await response.json();
}

function lireJoursFeries(payload: unknown): Map<string, string> {
  if (!estObjet(payload)) throw new Error("Réponse jours fériés invalide.");
  const resultat = new Map<string, string>();
  for (const [date, libelle] of Object.entries(payload)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof libelle === "string") {
      resultat.set(date, libelle);
    }
  }
  return resultat;
}

export function lireVacances(payload: unknown): VacancesRecord[] {
  if (!estObjet(payload) || !Array.isArray(payload.results)) {
    throw new Error("Réponse vacances scolaires invalide.");
  }
  const resultat: VacancesRecord[] = [];
  for (const ligne of payload.results) {
    if (!estObjet(ligne) || typeof ligne.start_date !== "string" || typeof ligne.end_date !== "string") continue;
    const startDate = ligne.start_date.slice(0, 10);
    const endDate = ligne.end_date.slice(0, 10);
    // Les vacances longues sont des intervalles [début, fin[, mais l'API
    // représente certaines fermetures d'une journée avec deux dates égales.
    if (endDate < startDate) continue;
    resultat.push({
      start_date: startDate,
      end_date: endDate,
      description: typeof ligne.description === "string" ? ligne.description : undefined,
    });
  }
  return resultat;
}

function lendemain(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function samediBloqueParPeriodeScolaire(
  samedi: string,
  debut: string,
  fin: string,
) {
  if (fin < debut) return false;

  // L'API exprime une période ordinaire du départ après les cours jusqu'au
  // matin de la reprise : seuls les samedis strictement entre les deux bornes
  // sont donc des samedis de vacances.
  if (debut < fin) return debut < samedi && samedi < fin;

  // Certaines fermetures ponctuelles, notamment le pont de l'Ascension 2027,
  // sont publiées avec deux bornes égales au vendredi. Elles ferment aussi le
  // samedi qui suit. Une fermeture ponctuelle un samedi ne bloque pas ce samedi.
  const jour = new Date(`${debut}T00:00:00Z`).getUTCDay();
  return jour === 5 && samedi === lendemain(debut);
}

export function samedisBloquesParVacances(
  samedis: string[],
  periodes: VacancesRecord[],
): string[] {
  return samedis.filter((samedi) =>
    periodes.some((periode) =>
      samediBloqueParPeriodeScolaire(
        samedi,
        periode.start_date,
        periode.end_date,
      ),
    ),
  );
}

export const synchroniser = authenticatedAction({
  args: {
    saison: v.string(),
    actualiserMemeSiRecent: v.optional(v.boolean()),
  },
  returns: v.object({
    lancee: v.boolean(),
    modifications: v.number(),
  }),
  handler: async (ctx, args) => {
    const saison = verifierSaison(args.saison);
    await ctx.runQuery(internal.access.requireTileAccess, {
      userId: ctx.userId,
      tile: "samedis",
    });
    const maintenant = Date.now();
    const reservation: { lancee: false } | {
      lancee: true;
      dateDebut: string;
      dateFin: string;
      startedAt: number;
    } = await ctx.runMutation(internal.samedis.sync.reserverSync, {
      saison,
      acteurUserId: ctx.userId,
      maintenant,
      actualiserMemeSiRecent: args.actualiserMemeSiRecent === true,
    });
    if (!reservation.lancee) return { lancee: false, modifications: 0 };

    try {
      const samedis = enumererSamedis(reservation.dateDebut, reservation.dateFin);
      const anneeDebut = Number(reservation.dateDebut.slice(0, 4));
      const anneeFin = Number(reservation.dateFin.slice(0, 4));
      const appelsFeries: Promise<unknown>[] = [];
      for (let annee = anneeDebut; annee <= anneeFin; annee += 1) {
        appelsFeries.push(chargerJson(`https://calendrier.api.gouv.fr/jours-feries/metropole/${annee}.json`));
      }
      const where = `location="Grenoble" and start_date <= date'${reservation.dateFin}' and end_date >= date'${reservation.dateDebut}'`;
      const urlVacances =
        "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/" +
        "fr-en-calendrier-scolaire/records?select=start_date,end_date,description" +
        `&where=${encodeURIComponent(where)}&limit=100`;
      const [feriesPayloads, vacancesPayload] = await Promise.all([
        Promise.all(appelsFeries),
        chargerJson(urlVacances),
      ]);
      const feries = new Map<string, string>();
      for (const payload of feriesPayloads) {
        for (const [date, libelle] of lireJoursFeries(payload)) feries.set(date, libelle);
      }
      const vacances = lireVacances(vacancesPayload);
      const blocages = samedis.map((date) => {
        const motifs: string[] = [];
        const sources: Array<"ferie" | "vacances"> = [];
        const ferie = feries.get(date);
        if (ferie) {
          motifs.push(`Jour férié : ${ferie}`);
          sources.push("ferie");
        }
        const periodes = vacances.filter(
          (periode) => samediBloqueParPeriodeScolaire(
            date,
            periode.start_date,
            periode.end_date,
          ),
        );
        const descriptions = [...new Set(periodes.map((periode) => periode.description ?? "Vacances scolaires"))];
        for (const description of descriptions) {
          motifs.push(`Vacances scolaires : ${texteCourt(description, "Le libellé des vacances", 160)}`);
          sources.push("vacances");
        }
        return { date, motifs, sources };
      });
      const modifications: number = await ctx.runMutation(internal.samedis.sync.appliquerSync, {
        saison,
        acteurUserId: ctx.userId,
        startedAt: reservation.startedAt,
        blocages,
      });
      return { lancee: true, modifications };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Synchronisation officielle impossible.";
      await ctx.runMutation(internal.samedis.sync.marquerEchec, {
        saison,
        startedAt: reservation.startedAt,
        message,
      });
      throw new ConvexError({
        code: "SAMEDIS_SYNCHRO_ECHEC",
        message: "Le calendrier officiel n'a pas pu être actualisé. Les dernières données ont été conservées.",
      });
    }
  },
});
