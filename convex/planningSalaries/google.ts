"use node";

import { google, type calendar_v3 } from "googleapis";
import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "../customFunctions";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import {
  bornesSaison,
  MAX_CRENEAUX_PAR_SAISON,
  PLACEHOLDER_RESOURCE,
} from "./lib";

function calendrierGoogleLecture() {
  const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) {
    throw new Error("Configuration du compte de service Google absente.");
  }
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  });
  return google.calendar({ version: "v3", auth });
}

function calendrierGoogleEcriture() {
  const clientId = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN;
  const configuration = [clientId, clientSecret, refreshToken];

  if (configuration.every((valeur) => !valeur)) {
    throw new Error(
      "Configuration OAuth Google Calendar absente. Connectez le compte escalade@caflarochebonneville.fr avant d'affecter un samedi.",
    );
  }
  if (configuration.some((valeur) => !valeur)) {
    throw new Error(
      "Configuration OAuth Google Calendar incomplète : client ID, client secret et refresh token sont tous requis.",
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

function dateParis(instant: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant;
  const morceaux = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const valeur = Object.fromEntries(morceaux.map((m) => [m.type, m.value]));
  return `${valeur.year}-${valeur.month}-${valeur.day}`;
}

function estSamedi(date: string): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === 6;
}

function memeOccurrence(candidate: string | null | undefined, attendue: string): boolean {
  if (!candidate) return false;
  if (candidate === attendue) return true;
  const candidateAt = Date.parse(candidate);
  const attendueAt = Date.parse(attendue);
  return Number.isFinite(candidateAt) && Number.isFinite(attendueAt) && candidateAt === attendueAt;
}

async function resoudreEventIdOrganisateur(
  calendar: calendar_v3.Calendar,
  operation: {
    calendarId: string;
    eventId: string;
    googleICalUid?: string;
    googleOccurrenceStart: string;
  },
): Promise<string> {
  if (!operation.googleICalUid) return operation.eventId;
  const occurrenceAt = Date.parse(operation.googleOccurrenceStart);
  const response = await calendar.events.list({
    calendarId: operation.calendarId,
    iCalUID: operation.googleICalUid,
    singleEvents: true,
    showDeleted: false,
    maxResults: 10,
    ...(Number.isFinite(occurrenceAt) ? {
      timeMin: new Date(occurrenceAt - 36 * 60 * 60 * 1000).toISOString(),
      timeMax: new Date(occurrenceAt + 36 * 60 * 60 * 1000).toISOString(),
    } : {}),
  });
  const occurrence = (response.data.items ?? []).find((event) =>
    memeOccurrence(
      event.originalStartTime?.dateTime ?? event.originalStartTime?.date ??
        event.start?.dateTime ?? event.start?.date,
      operation.googleOccurrenceStart,
    ));
  if (!occurrence?.id) {
    throw new Error("Copie organisatrice de l'événement Google introuvable.");
  }
  return occurrence.id;
}

function lireEvenement(
  event: calendar_v3.Schema$Event,
  resourceCalendarId: string,
) {
  const debut = event.start?.dateTime ?? event.start?.date;
  const fin = event.end?.dateTime ?? event.end?.date;
  if (!event.id || !debut || !fin) return null;
  const date = dateParis(debut);
  if (!estSamedi(date)) return null;
  const titre = event.summary?.trim() || "Cours du samedi";
  return {
    date,
    debut,
    fin,
    groupe: titre,
    titre,
    // Les ressources servent uniquement à découvrir les copies participantes.
    // Les participants doivent être modifiés sur la copie organisatrice pour
    // que Google propage le changement aux autres calendriers.
    googleCalendarId: event.organizer?.email ?? resourceCalendarId,
    googleEventId: event.id,
    ...(event.iCalUID ? { googleICalUid: event.iCalUID } : {}),
    googleOccurrenceStart: event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? debut,
    currentResourceCalendarId: resourceCalendarId,
    ...(event.etag ? { etag: event.etag } : {}),
  };
}

export const synchroniser = authenticatedAction({
  args: { saison: v.string() },
  returns: v.object({ lancee: v.boolean(), modifications: v.number() }),
  handler: async (ctx, args) => {
    const bornes = bornesSaison(args.saison);
    await ctx.runQuery(internal.access.requireTileAccess, { userId: ctx.userId, tile: "planning_salaries_samedis" });
    const startedAt = Date.now();
    const reservation: { lancee: boolean; startedAt: number | null } = await ctx.runMutation(
      internal.planningSalaries.syncDb.reserverSync,
      { saison: bornes.saison, maintenant: startedAt, forcer: false },
    );
    if (!reservation.lancee || reservation.startedAt === null) return { lancee: false, modifications: 0 };
    try {
      const contexte: { resources: Array<{ salarieId: string; resourceCalendarId: string }> } =
        await ctx.runQuery(internal.planningSalaries.syncDb.contexteGoogle, {});
      const resourceCalendarIds = [...new Map([
        PLACEHOLDER_RESOURCE,
        ...contexte.resources.map((r) => r.resourceCalendarId.toLowerCase()),
      ].map((resource) => [resource.toLowerCase(), resource])).values()];
      const calendar = calendrierGoogleLecture();
      const parOccurrence = new Map<
        string,
        NonNullable<ReturnType<typeof lireEvenement>>
      >();
      for (const resourceCalendarId of resourceCalendarIds) {
        let pageToken: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const response = await calendar.events.list({
            calendarId: resourceCalendarId,
            timeMin: bornes.timeMin,
            timeMax: bornes.timeMax,
            singleEvents: true,
            showDeleted: false,
            maxResults: 250,
            pageToken,
          });
          for (const event of response.data.items ?? []) {
            const lu = lireEvenement(event, resourceCalendarId);
            if (!lu) continue;
            const cle = `${lu.googleICalUid ?? lu.googleEventId}\u0000${lu.googleOccurrenceStart}`;
            const dejaVu = parOccurrence.get(cle);
            if (
              dejaVu &&
              dejaVu.currentResourceCalendarId.toLowerCase() !==
                lu.currentResourceCalendarId.toLowerCase()
            ) {
              throw new Error(
                `L'événement ${lu.titre} est présent dans plusieurs ressources gérées.`,
              );
            }
            parOccurrence.set(cle, lu);
            if (parOccurrence.size > MAX_CRENEAUX_PAR_SAISON) {
              throw new Error("Trop d'événements Google pour une saison.");
            }
          }
          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
        if (pageToken) {
          throw new Error(
            `Le calendrier de ressource ${resourceCalendarId} dépasse la limite de synchronisation.`,
          );
        }
      }
      const evenements = [...parOccurrence.values()];
      const modifications: number = await ctx.runMutation(internal.planningSalaries.syncDb.appliquerSync, {
        saison: bornes.saison,
        startedAt: reservation.startedAt,
        acteurUserId: ctx.userId,
        evenements,
      });
      await ctx.runMutation(internal.planningSalaries.alertes.reconcilierSaison, {
        saison: bornes.saison,
        maintenant: Date.now(),
      });
      return { lancee: true, modifications };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Erreur Google Calendar";
      await ctx.runMutation(internal.planningSalaries.syncDb.marquerEchecSync, {
        saison: bornes.saison,
        startedAt: reservation.startedAt,
        message,
      });
      throw new ConvexError({ code: "PLANNING_SYNC_GOOGLE", message: "La synchronisation Google Calendar a échoué. Les dernières données ont été conservées." });
    }
  },
});

export const traiterOperation = internalAction({
  args: { operationId: v.id("planning_salaries_google_operations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation: {
      calendarId: string;
      eventId: string;
      googleICalUid?: string;
      googleOccurrenceStart: string;
      sourceResourceCalendarId: string;
      targetResourceCalendarId: string;
      managedResourceCalendarIds: string[];
    } | null =
      await ctx.runQuery(internal.planningSalaries.syncDb.contexteOperation, args);
    if (!operation) return null;
    try {
      const calendar = calendrierGoogleEcriture();
      const eventId = await resoudreEventIdOrganisateur(calendar, operation);
      const response = await calendar.events.get({ calendarId: operation.calendarId, eventId });
      const attendees = [...(response.data.attendees ?? [])];
      const target = operation.targetResourceCalendarId.toLowerCase();
      const resourcesGerees = new Set(
        operation.managedResourceCalendarIds.map((resource) => resource.toLowerCase()),
      );
      resourcesGerees.add(operation.sourceResourceCalendarId.toLowerCase());
      const preserves = attendees.filter(
        (attendee) => !attendee.email || !resourcesGerees.has(attendee.email.toLowerCase()),
      );
      if (!preserves.some((attendee) => attendee.email?.toLowerCase() === target)) {
        preserves.push({ email: operation.targetResourceCalendarId, resource: true });
      }
      const patchResponse = await calendar.events.patch(
        {
          calendarId: operation.calendarId,
          eventId,
          sendUpdates: "none",
          requestBody: { attendees: preserves },
        },
        response.data.etag
          ? { headers: { "If-Match": response.data.etag } }
          : undefined,
      );
      await ctx.runMutation(internal.planningSalaries.syncDb.marquerOperation, {
        ...args,
        succes: true,
        ...(patchResponse.data.etag ? { etag: patchResponse.data.etag } : {}),
      });
    } catch (cause) {
      const resultat: { retry: boolean; tentatives: number } = await ctx.runMutation(
        internal.planningSalaries.syncDb.marquerOperation,
        { ...args, succes: false, erreur: cause instanceof Error ? cause.message : "Erreur Google Calendar" },
      );
      if (resultat.retry) {
        await ctx.scheduler.runAfter(60_000 * 2 ** (resultat.tentatives - 1), internal.planningSalaries.google.traiterOperation, args);
      }
    }
    return null;
  },
});
