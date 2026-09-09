# Cartographie des composants

Cette cartographie indique où commencer une modification. Elle ne duplique pas
le détail métier de chaque module.

## Socle

| Responsabilité | Frontend | Backend |
|---|---|---|
| Initialisation | `src/main.tsx` | `convex/convex.config.ts` |
| Routage | `src/App.tsx` | — |
| Mise en page staff | `src/components/Layout.tsx` | — |
| Autorisation par tuile | `src/components/RequireAccess.tsx` | `convex/access.ts` |
| Saison courante | `src/contexts/SeasonContext.tsx` | `convex/saisons.ts`, `convex/saisonUtils.ts` |
| Utilisateurs et tuiles | `src/pages/Configurations.tsx` | `convex/users.ts` |
| Authentification | `src/pages/Login.tsx` | `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`, `convex/staffOtp.ts`, `convex/aboOtp.ts`, `convex/samediOtp.ts`, `convex/planningSalariesOtp.ts` |
| Schéma | — | `convex/schema.ts` |
| Wrappers sécurisés | — | `convex/customFunctions.ts` |

## Modules staff

| Module et routes | Pages principales | Backend |
|---|---|---|
| Tableau de bord `/` | `src/pages/Dashboard.tsx`, `src/config/tiles.ts` | `convex/users.ts` |
| Comptabilité `/compta` | `src/pages/Compta.tsx` | `convex/transactions.ts`, `convex/tiers.ts`, `convex/analytiques.ts`, `convex/typesDocuments.ts` |
| Paiements `/paiements/*` | `src/pages/Paiements/` | `convex/paiements.ts`, `convex/helloasso.ts`, `convex/drive.ts` |
| Budget `/budget/*` | `src/pages/Budget/` | `convex/paie.ts`, `convex/cours.ts`, `convex/previsionnels.ts`, `convex/effectifs.ts` |
| Licences `/licences-cours` | `src/pages/LicencesEnCours.tsx` | `convex/abo/licencesEnCours.ts`, `convex/abo/licences.ts`, `convex/abo/sync.ts` |
| Contacts des cours `/contacts-cours`, `/contacts-cours/copier` | `src/pages/ContactsCours.tsx`, `src/pages/ContactsCoursCopie.tsx`, `src/utils/contactsCours.ts` | `convex/contactsCours.ts`, `convex/abo/sync.ts` |
| Remboursements élèves `/remboursements-eleves` | `src/pages/RemboursementsEleves.tsx`, `src/utils/remboursements.ts` | `convex/remboursements.ts`, `convex/remboursementsHelloAsso.ts` |
| Samedis — gestion `/gestion-samedis` | `src/pages/GestionSamedis.tsx`, `src/samedis/ManagerSlot.tsx` | `convex/samedis/admin.ts`, `convex/samedis/calendrier.ts`, `convex/samedis/reservations.ts`, `convex/samedis/sync.ts`, `convex/samedis/notifications.ts` |
| Planning salariés `/gestion-planning-salaries-samedis` | `src/planningSalariesSamedis/GestionPlanningSalaries.tsx` | `convex/planningSalaries/annuaire.ts`, `convex/planningSalaries/calendrier.ts`, `convex/planningSalaries/affectations.ts`, `convex/planningSalaries/google.ts`, `convex/planningSalaries/alertes.ts` |
| Administration `/configurations` | `src/pages/Configurations.tsx`, `src/components/Configurations/DashboardTilesPanel.tsx` | `convex/users.ts`, `convex/saisons.ts`, `convex/bootstrap.ts` |

Les routes `/adherents`, `/evenements` et `/statistiques` sont actuellement des
placeholders déclarés dans `src/App.tsx`, sans module métier associé.

## Module Samedis après-midi

La documentation fonctionnelle complète est dans
[12-module-samedis.md](12-module-samedis.md).

| Parcours | Frontend | Backend |
|---|---|---|
| Connexion et identité dédiées `/samedis` | `src/samedis/SamedisApp.tsx`, `src/samedis/SamediLogin.tsx` | `convex/auth.ts`, `convex/samediOtp.ts`, `convex/samedis/identity.ts` |
| Calendrier participant | `src/samedis/ParticipantCalendar.tsx` | `convex/samedis/calendrier.ts`, `convex/samedis/reservations.ts` |
| Agenda et participants gestionnaire | `src/pages/GestionSamedis.tsx`, `src/samedis/ManagerSlot.tsx`, `src/samedis/ParticipantManager.tsx` | `convex/samedis/admin.ts`, `convex/samedis/calendrier.ts`, `convex/samedis/reservations.ts` |
| Sources officielles et notifications | états intégrés à la page de gestion | `convex/samedis/sync.ts`, `convex/samedis/notifications.ts`, `convex/email.ts` |

## Planning des salariés du samedi

Voir [13-planning-salaries-samedis.md](13-planning-salaries-samedis.md).

| Parcours | Frontend | Backend |
|---|---|---|
| Connexion et identité `/planning-salaries-samedis` | `src/planningSalariesSamedis/PlanningSalariesApp.tsx`, `src/planningSalariesSamedis/PlanningSalariesLogin.tsx` | `convex/auth.ts`, `convex/planningSalariesOtp.ts`, `convex/planningSalaries/identity.ts` |
| Planning partagé et compteurs | `src/planningSalariesSamedis/PlanningBoard.tsx` | `convex/planningSalaries/calendrier.ts`, `convex/planningSalaries/affectations.ts` |
| Annuaire et gestion | `src/planningSalariesSamedis/GestionPlanningSalaries.tsx` | `convex/planningSalaries/annuaire.ts`, `convex/planningSalaries/calendrier.ts` |
| Google et rappels du lundi | états intégrés à la gestion | `convex/planningSalaries/google.ts`, `convex/planningSalaries/syncDb.ts`, `convex/planningSalaries/alertes.ts`, `convex/email.ts` |

## Module Abonnements

La documentation fonctionnelle complète est dans
[5-module-abonnements.md](5-module-abonnements.md).

| Parcours | Frontend | Backend |
|---|---|---|
| Connexion publique | `src/abonnements/AboLogin.tsx` | `convex/auth.ts`, `convex/abo/identity.ts` |
| Demande et suivi | `src/abonnements/pages/` | `convex/abo/demandes.ts`, `convex/abo/config.ts` |
| Messagerie | `src/abonnements/FilDiscussion.tsx` | `convex/abo/messages.ts`, `convex/abo/emails.ts` |
| Administration | `src/abonnements/admin/` | `convex/abo/` |
| Prévisualisation abonné en lecture seule `/gestion-abonnements/apercu/:dossierId` | `src/abonnements/admin/ApercuAbonne.tsx`, `src/abonnements/admin/apercuAbonne.logic.ts` | `convex/abo/apercu.ts` |
| Paiements | `src/abonnements/admin/Paiements.tsx` | `convex/abo/paiements.ts`, `convex/helloasso.ts` |
| Licences et conflits | `src/abonnements/admin/Licences.tsx`, `src/abonnements/admin/FusionDossiersModal.tsx` | `convex/abo/licences.ts`, `convex/abo/matching.ts`, `convex/abo/fusionsDossiers.ts` |
| Tests d'autonomie | `src/abonnements/admin/Tests.tsx`, `src/abonnements/admin/SuiviTestsModal.tsx`, `src/abonnements/pages/Suivi.tsx`, `src/abonnements/pages/TestAutonomieDirectV2.tsx`, `src/abonnements/NotificationDisponibilitesTest.tsx` | `convex/abo/tests.ts`, `convex/abo/testNotifications.ts`, `convex/abo/testDocuments.ts`, `convex/abo/testDocumentsDrive.ts`, `convex/abo/testAutonomiePdf.ts` |
| Règlements signés | `src/abonnements/admin/Reglements.tsx`, `src/abonnements/pages/Suivi.tsx` | `convex/abo/reglements.ts`, `convex/abo/reglementsDrive.ts`, `convex/abo/reglementsConstants.ts` |
| Historique Google Drive | `src/abonnements/admin/HistoriqueDrive.tsx` | `convex/abo/testDocumentsDrive.ts`, `convex/abo/reglementsDrive.ts`, `convex/abo/driveArchives.ts` |
| Compteur public | `src/abonnements/Compteur.tsx` | `convex/abo/compteur.ts` |
| Anomalies à traiter et masquées manuellement | `src/abonnements/admin/Anomalies.tsx`, `src/abonnements/admin/CompteurJauge.tsx`, `src/abonnements/abo.css` | `convex/abo/compteur.ts` (`vAnomalies`, `vCompteur`, `acquitterAnomalie`, `reactiverAnomalie`), `convex/schema.ts` (`abo_anomalies_acquittements`, `abo_anomalies_acquittements_journal`), `convex/abo/config.ts` (purge de l'état et du journal au reset) |
| Synchronisations | chargement des pages concernées, `src/abonnements/admin/SyncStatusPanel.tsx` | `convex/abo/sync.ts`, `convex/abo/scrap.ts`, calculs temporels partagés dans `convex/abo/syncStatus.ts` |

## Composants et utilitaires partagés

| Élément | Emplacement | Usage |
|---|---|---|
| Retour au portail | `src/components/PortalReturnLink.tsx` | Navigation commune des routes staff vers le tableau de bord |
| Tuiles | `src/components/Tile.tsx` | Navigation du tableau de bord |
| Formulaire de transaction | `src/components/TransactionFormModal.tsx` | Comptabilité |
| Formulaire prévisionnel | `src/components/PrevisionnelFormModal.tsx` | Budget prévisionnel |
| Composants Budget | `src/components/Budget/` | Cours, salariés et paramètres |
| Calcul de paie | `src/utils/paieCompute.ts` | Calculs purs du budget |
| Planning | `src/utils/planning.ts` | Manipulation des séances |
| Contacts des cours | `src/utils/contactsCours.ts` | Recherche normalisée, découpage des encadrants, dédoublonnage et lots de 99 emails, empreinte de sélection et liens de contact |
| Remboursements élèves | `src/utils/remboursements.ts` | Montants en centimes, liens Gmail et formulaires HelloAsso fixes |
| Couleurs | `src/utils/colors.ts` | Présentation cohérente |
| Diff d'upsert | `convex/dbUtils.ts` | Évite les écritures Convex inutiles |

## Intégrations externes

| Service | Point d'intégration |
|---|---|
| Email staff | `convex/email.ts` |
| Email Abonnements et notifications de fusion | `convex/abo/emails.ts`, `convex/abo/fusionsDossiers.ts`, `convex/email.ts` |
| HelloAsso | `convex/helloasso.ts`, `convex/abo/paiements.ts` |
| HelloAsso — remboursements élèves | `convex/remboursementsHelloAsso.ts` |
| Google Drive | `convex/drive.ts`, `convex/abo/testDocumentsDrive.ts`, `convex/abo/reglementsDrive.ts`, `convex/abo/driveArchives.ts` |
| DocuSeal / webhook n8n des règlements | `convex/abo/reglementsWebhook.ts`, `convex/abo/reglementsImports.ts` |
| Site du club et snapshot des élèves en cours | `convex/abo/scrap.ts`, `convex/abo/sync.ts` |
| Annuaire des licences | `convex/abo/licences.ts` |
| Jours fériés et calendrier scolaire | `convex/samedis/sync.ts` |
| Synthèses des samedis | `convex/samedis/notifications.ts`, `convex/email.ts` |
| Google Calendar — planning salariés | `convex/planningSalaries/google.ts`, `convex/planningSalaries/syncDb.ts` |
| OTP et alertes du planning salariés | `convex/planningSalariesOtp.ts`, `convex/planningSalaries/alertes.ts`, `convex/email.ts` |

Les secrets associés résident dans les variables d'environnement Convex. Le
frontend ne reçoit que `VITE_CONVEX_URL`.
