// Crons Convex — VOLONTAIREMENT VIDES.
//
// Les synchros du module Abonnements (scrap abonnés club, sync HelloAsso, import
// des élèves en cours, import de l'annuaire des licences) tournaient ici en crons
// horaires 24/7. Elles consommaient énormément de Database I/O même la nuit / hors
// période d'inscriptions, alors que ce sont des données consultées par à-coups.
//
// Elles sont désormais déclenchées EN ON-DEMAND au chargement des pages qui en ont
// besoin, avec un verrou anti-rejeu partagé (4 h par défaut, hors annuaire) :
// voir convex/abo/sync.ts.
//   - page Validation paiements cours → syncPourPaiements (HelloAsso)
//   - espace admin abonnements        → syncPourAbo (HelloAsso → scrap → annuaire → élèves)
//   - tuile licences élèves en cours   → syncPourLicencesCours (annuaire + élèves)
//
// ⚠️ Conséquence assumée : le compteur public (iframe du site club) ne se
// rafraîchit que lorsqu'un admin ouvre l'appli. Si un jour il faut garantir sa
// fraîcheur hors présence admin, rétablir ICI un unique cron lâche sur le scrap
// (internal.abo.scrap.scraperAbonnes), à cadence espacée — précédé d'un
// commentaire `// CRON-OK: <raison>` (sinon le hook check-cron-justification.mjs
// bloque l'ajout d'un cron).

import { cronJobs } from "convex/server";

const crons = cronJobs();

export default crons;
