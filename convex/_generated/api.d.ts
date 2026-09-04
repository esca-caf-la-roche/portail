/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as abo_auth from "../abo/auth.js";
import type * as abo_compteur from "../abo/compteur.js";
import type * as abo_config from "../abo/config.js";
import type * as abo_demandes from "../abo/demandes.js";
import type * as abo_demo from "../abo/demo.js";
import type * as abo_driveArchives from "../abo/driveArchives.js";
import type * as abo_driveArchivesRecherche from "../abo/driveArchivesRecherche.js";
import type * as abo_emails from "../abo/emails.js";
import type * as abo_emailsRappel from "../abo/emailsRappel.js";
import type * as abo_fusionsDossiers from "../abo/fusionsDossiers.js";
import type * as abo_identity from "../abo/identity.js";
import type * as abo_lib from "../abo/lib.js";
import type * as abo_licences from "../abo/licences.js";
import type * as abo_licencesCoursIdentite from "../abo/licencesCoursIdentite.js";
import type * as abo_licencesEnCours from "../abo/licencesEnCours.js";
import type * as abo_matching from "../abo/matching.js";
import type * as abo_messages from "../abo/messages.js";
import type * as abo_paiements from "../abo/paiements.js";
import type * as abo_reglements from "../abo/reglements.js";
import type * as abo_reglementsConstants from "../abo/reglementsConstants.js";
import type * as abo_reglementsDrive from "../abo/reglementsDrive.js";
import type * as abo_reglementsImports from "../abo/reglementsImports.js";
import type * as abo_reglementsWebhook from "../abo/reglementsWebhook.js";
import type * as abo_scrap from "../abo/scrap.js";
import type * as abo_statutAbonnement from "../abo/statutAbonnement.js";
import type * as abo_sync from "../abo/sync.js";
import type * as abo_syncConstants from "../abo/syncConstants.js";
import type * as abo_testAutonomiePdf from "../abo/testAutonomiePdf.js";
import type * as abo_testDocuments from "../abo/testDocuments.js";
import type * as abo_testDocumentsDrive from "../abo/testDocumentsDrive.js";
import type * as abo_testNotifications from "../abo/testNotifications.js";
import type * as abo_tests from "../abo/tests.js";
import type * as aboOtp from "../aboOtp.js";
import type * as access from "../access.js";
import type * as analytiques from "../analytiques.js";
import type * as auth from "../auth.js";
import type * as bootstrap from "../bootstrap.js";
import type * as contactsCours from "../contactsCours.js";
import type * as cours from "../cours.js";
import type * as crons from "../crons.js";
import type * as customFunctions from "../customFunctions.js";
import type * as dbUtils from "../dbUtils.js";
import type * as drive from "../drive.js";
import type * as effectifs from "../effectifs.js";
import type * as email from "../email.js";
import type * as emailValidation from "../emailValidation.js";
import type * as helloasso from "../helloasso.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as paie from "../paie.js";
import type * as paiements from "../paiements.js";
import type * as planningSalaries_affectations from "../planningSalaries/affectations.js";
import type * as planningSalaries_alertes from "../planningSalaries/alertes.js";
import type * as planningSalaries_annuaire from "../planningSalaries/annuaire.js";
import type * as planningSalaries_calendrier from "../planningSalaries/calendrier.js";
import type * as planningSalaries_google from "../planningSalaries/google.js";
import type * as planningSalaries_identity from "../planningSalaries/identity.js";
import type * as planningSalaries_lib from "../planningSalaries/lib.js";
import type * as planningSalaries_syncDb from "../planningSalaries/syncDb.js";
import type * as planningSalariesOtp from "../planningSalariesOtp.js";
import type * as previsionnels from "../previsionnels.js";
import type * as references from "../references.js";
import type * as remboursements from "../remboursements.js";
import type * as remboursementsHelloAsso from "../remboursementsHelloAsso.js";
import type * as saisonUtils from "../saisonUtils.js";
import type * as saisons from "../saisons.js";
import type * as samediOtp from "../samediOtp.js";
import type * as samedis_admin from "../samedis/admin.js";
import type * as samedis_calendrier from "../samedis/calendrier.js";
import type * as samedis_identity from "../samedis/identity.js";
import type * as samedis_lib from "../samedis/lib.js";
import type * as samedis_notifications from "../samedis/notifications.js";
import type * as samedis_reservations from "../samedis/reservations.js";
import type * as samedis_sync from "../samedis/sync.js";
import type * as staffOtp from "../staffOtp.js";
import type * as tiers from "../tiers.js";
import type * as transactions from "../transactions.js";
import type * as typesDocuments from "../typesDocuments.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "abo/auth": typeof abo_auth;
  "abo/compteur": typeof abo_compteur;
  "abo/config": typeof abo_config;
  "abo/demandes": typeof abo_demandes;
  "abo/demo": typeof abo_demo;
  "abo/driveArchives": typeof abo_driveArchives;
  "abo/driveArchivesRecherche": typeof abo_driveArchivesRecherche;
  "abo/emails": typeof abo_emails;
  "abo/emailsRappel": typeof abo_emailsRappel;
  "abo/fusionsDossiers": typeof abo_fusionsDossiers;
  "abo/identity": typeof abo_identity;
  "abo/lib": typeof abo_lib;
  "abo/licences": typeof abo_licences;
  "abo/licencesCoursIdentite": typeof abo_licencesCoursIdentite;
  "abo/licencesEnCours": typeof abo_licencesEnCours;
  "abo/matching": typeof abo_matching;
  "abo/messages": typeof abo_messages;
  "abo/paiements": typeof abo_paiements;
  "abo/reglements": typeof abo_reglements;
  "abo/reglementsConstants": typeof abo_reglementsConstants;
  "abo/reglementsDrive": typeof abo_reglementsDrive;
  "abo/reglementsImports": typeof abo_reglementsImports;
  "abo/reglementsWebhook": typeof abo_reglementsWebhook;
  "abo/scrap": typeof abo_scrap;
  "abo/statutAbonnement": typeof abo_statutAbonnement;
  "abo/sync": typeof abo_sync;
  "abo/syncConstants": typeof abo_syncConstants;
  "abo/testAutonomiePdf": typeof abo_testAutonomiePdf;
  "abo/testDocuments": typeof abo_testDocuments;
  "abo/testDocumentsDrive": typeof abo_testDocumentsDrive;
  "abo/testNotifications": typeof abo_testNotifications;
  "abo/tests": typeof abo_tests;
  aboOtp: typeof aboOtp;
  access: typeof access;
  analytiques: typeof analytiques;
  auth: typeof auth;
  bootstrap: typeof bootstrap;
  contactsCours: typeof contactsCours;
  cours: typeof cours;
  crons: typeof crons;
  customFunctions: typeof customFunctions;
  dbUtils: typeof dbUtils;
  drive: typeof drive;
  effectifs: typeof effectifs;
  email: typeof email;
  emailValidation: typeof emailValidation;
  helloasso: typeof helloasso;
  http: typeof http;
  migrations: typeof migrations;
  paie: typeof paie;
  paiements: typeof paiements;
  "planningSalaries/affectations": typeof planningSalaries_affectations;
  "planningSalaries/alertes": typeof planningSalaries_alertes;
  "planningSalaries/annuaire": typeof planningSalaries_annuaire;
  "planningSalaries/calendrier": typeof planningSalaries_calendrier;
  "planningSalaries/google": typeof planningSalaries_google;
  "planningSalaries/identity": typeof planningSalaries_identity;
  "planningSalaries/lib": typeof planningSalaries_lib;
  "planningSalaries/syncDb": typeof planningSalaries_syncDb;
  planningSalariesOtp: typeof planningSalariesOtp;
  previsionnels: typeof previsionnels;
  references: typeof references;
  remboursements: typeof remboursements;
  remboursementsHelloAsso: typeof remboursementsHelloAsso;
  saisonUtils: typeof saisonUtils;
  saisons: typeof saisons;
  samediOtp: typeof samediOtp;
  "samedis/admin": typeof samedis_admin;
  "samedis/calendrier": typeof samedis_calendrier;
  "samedis/identity": typeof samedis_identity;
  "samedis/lib": typeof samedis_lib;
  "samedis/notifications": typeof samedis_notifications;
  "samedis/reservations": typeof samedis_reservations;
  "samedis/sync": typeof samedis_sync;
  staffOtp: typeof staffOtp;
  tiers: typeof tiers;
  transactions: typeof transactions;
  typesDocuments: typeof typesDocuments;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
