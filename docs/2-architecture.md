# Architecture technique

Ce document présente les frontières techniques du portail. La localisation
détaillée de chaque fonctionnalité se trouve dans
[8-component-mapping.md](8-component-mapping.md).

## Vue d'ensemble

```text
Navigateur
  |
  | React, HashRouter, hooks Convex temps réel
  v
API publique Convex
  |
  +-- fonctions applicatives authentifiées
  +-- fonctions publiques limitées à l'auth et aux parcours isolés
  +-- fonctions internes pour les traitements orchestrés
  |
  +-- base Convex et stockage de fichiers
  +-- SMTP
  +-- HelloAsso
  +-- Google Drive
  +-- site du club et annuaire des licences
```

Le frontend est une application React monopage. Convex fournit la base temps
réel, l'authentification, les fonctions serveur, les actions Node.js et les
tâches internes. Il n'existe pas de serveur HTTP applicatif séparé.

## Stack technologique

| Couche | Technologie |
|---|---|
| Interface | React 19, TypeScript 6 |
| Build | Vite 8 |
| Routage | React Router 7, `HashRouter` |
| Styles | CSS natif, Flexbox et Grid |
| Backend et base | Convex 1.43 |
| Authentification | `@convex-dev/auth` |
| Icônes | `lucide-react` |
| Intégrations | HelloAsso, SMTP, Google Drive, exports du site club |
| Hébergement frontend | GitHub Pages |

## Frontend

`src/main.tsx` initialise le client Convex et monte `src/App.tsx`.
`SeasonProvider` expose la saison sélectionnée aux modules concernés.

`src/App.tsx` distingue trois ensembles de routes :

| Ensemble | Routes principales | Protection |
|---|---|---|
| Public ou isolé | `/login`, `/abonnements`, `/compteur`, `/samedis`, `/planning-salaries-samedis` | Selon le parcours et le provider OTP |
| Staff | `/`, `/compta`, `/paiements`, `/budget`, `/licences-cours`, `/contacts-cours`, `/contacts-cours/copier`, `/remboursements-eleves`, `/gestion-samedis`, `/gestion-planning-salaries-samedis` | `Layout` puis `RequireAccess` |
| Administration | `/configurations`, `/gestion-abonnements` | Rôle admin ou tuile dédiée |

Le routage par hash permet de servir toutes les routes depuis GitHub Pages sans
réécriture serveur. L'affichage d'une tuile dans le tableau de bord ne constitue
pas à lui seul une autorisation : `RequireAccess` protège aussi la route, et le
backend contrôle les droits avant d'accéder aux données.

L'ordre, la couleur, le libellé et la description des tuiles du tableau de bord
sont des préférences globales, hors saison, administrables depuis Configurations.
Elles ne modifient jamais les autorisations : celles-ci restent définies
uniquement par `allowedTiles`.

Les styles globaux sont dans `src/index.css`. Les mini-apps isolées complètent
ces règles avec `src/abonnements/abo.css` et `src/samedis/samedis.css` ; le
design n'est donc plus contenu dans un fichier CSS unique.

## Backend Convex

`convex/schema.ts` définit les tables d'authentification et les tables métier,
réparties en cinq domaines :

- référentiels, saisons et utilisateurs ;
- comptabilité et prévisionnels ;
- cours, masse salariale et paiements ;
- synchronisations et intégrations externes ;
- inscriptions, licences, tests et messagerie du module Abonnements.

Le domaine Abonnements conserve dans Convex les données de la campagne en
cours, y compris les métadonnées et liens Drive des scans de tests, les
règlements et les résolutions de conflits de licence. Les fichiers eux-mêmes
restent dans Google Drive : après un changement de campagne, ils demeurent
consultables par recherche dans Drive, sans conserver dans Convex leur ancien
état de traitement.

Les fichiers à la racine de `convex/` portent les domaines partagés ou staff.
`convex/abo/` isole le domaine Abonnements, `convex/samedis/` regroupe le
calendrier, les réservations, la synchronisation et les notifications des
samedis, et `convex/planningSalaries/` porte l'annuaire, le planning Google,
les affectations et alertes des salariés. Les fonctions réutilisables de
contrôle d'accès sont dans `convex/access.ts`, `convex/abo/auth.ts` et
`convex/customFunctions.ts`.

### Frontières de sécurité

Par défaut, un endpoint applicatif utilise `authenticatedQuery`,
`authenticatedMutation` ou `authenticatedAction` depuis
`convex/customFunctions.ts`. Ces wrappers refusent une identité absente avant
d'exécuter le handler.

Les imports directs depuis `_generated/server` sont réservés aux fonctions
internes et aux rares surfaces volontairement publiques, notamment le processus
d'authentification, l'identité Abonnements et le compteur public. Une fonction
authentifiée peut encore exiger une tuile ou un rôle via les helpers d'accès.

Voir [3-authentification.md](3-authentification.md) pour les populations et
[6-conventions.md](6-conventions.md) pour les règles applicables aux nouveaux
endpoints.

## Données et saisonnalité

La saison est un axe transverse du portail. Le frontend conserve la sélection
courante dans `localStorage`, tandis que les fonctions métier reçoivent ou
dérivent la saison servant à filtrer les données. Toute nouvelle tuile doit
définir explicitement son comportement lors d'un changement de saison.

La tuile `contacts_cours` est hors saison : elle reflète le snapshot externe
courant `abo_eleves_en_cours`, sans historique ni bascule par saison. Sa route
`/contacts-cours` masque donc le sélecteur de saison et ne transmet aucune
saison au backend.

La tuile `remboursements_eleves` est également hors saison. Une demande reste
active jusqu'à son paiement ou son annulation, puis demeure consultable dans
les archives. Les bénéficiaires conservent un instantané autonome de l'élève :
les archives ne dépendent donc pas de la présence future de celui-ci dans
`abo_eleves_en_cours`.

Le module Abonnements a son propre cycle de campagne, distinct de la saison
comptable. Sa réinitialisation purgera toutes les données de suivi de la
campagne achevée, dont les archives Convex des tests et règlements ainsi que
les fusions et leurs notifications. Google Drive reste l'historique des
documents des campagnes précédentes. Seuls le snapshot des abonnés N-1 et le
cache courant de l'annuaire des licences sont conservés dans Convex.

Le module Samedis suit la saison globale. Les configurations, créneaux et
réservations portent la saison et sont lus par index. Une saison contenant des
réservations ne peut pas être supprimée ; il faut les annuler auparavant. Les
participants et l'outbox de notifications sont transverses : l'autorisation
d'une personne et la traçabilité d'un envoi ne disparaissent pas lors d'une
suppression de saison.

Le planning salarié suit aussi la saison globale, du 1er septembre au 31 août.
Ses affectations bloquent la suppression ; les créneaux importés, opérations
Google, états de synchronisation et alertes sont supprimés en cascade. Son
annuaire reste transversal pour conserver identités OTP et ressources Google.

Les relations et index sont définis dans `convex/schema.ts`. Les collections
potentiellement volumineuses doivent être bornées, paginées ou parcourues par
lots conformément aux règles Convex du projet.

## Synchronisations externes

Les synchronisations HelloAsso, site du club, annuaire des licences et élèves en
cours sont déclenchées à la demande depuis les pages concernées. L'orchestrateur
`convex/abo/sync.ts` utilise un verrou partagé côté serveur, avec une fenêtre
de quatre heures par défaut, hors créneaux de l'annuaire, pour éviter les appels
et écritures répétés.

Après une réinitialisation Abonnements, les synchronisations de campagne de
l'espace Abonnements (site club, annuaire et élèves utilisés par les vagues) ne
sont pas actualisées tant qu'un admin n'a pas explicitement réactivé les imports,
une fois les sources passées à la nouvelle campagne. Cette pause évite notamment
de réimporter comme « élèves en cours » les élèves de la campagne précédente,
sans bloquer les autres tuiles qui partagent ce snapshot.

À l'ouverture de `/contacts-cours`, seule la source des élèves est demandée. La
page continue d'exploiter le dernier snapshot disponible si cette actualisation
échoue. Les actions de contact restent entièrement côté navigateur : copie dans
le presse-papiers, ouverture de l'application WhatsApp sur mobile (y compris
iPadOS tactile) ou de WhatsApp Web sur ordinateur, et composition dans Gmail
avec le compte `coursescalade@caflarochebonneville.fr`. Le brouillon de groupe
place les destinataires en CCI. Aucun email n'est envoyé par Convex depuis cette
tuile.

La copie d'un groupe de 1 à 100 emails est directe. Au-delà de 100 adresses,
`/contacts-cours/copier` reconstitue la sélection depuis les filtres transmis
dans l'état de navigation, sans adresse dans l'URL ni dans l'historique. Cette
page ne relance aucune synchronisation et répartit les emails en lots de 99.
Elle conserve dans `sessionStorage` uniquement une empreinte de la sélection et
les numéros des lots copiés ; une sélection différente réinitialise la
progression et aucune adresse email n'est stockée.

La page `/licences-cours` n'ouvre aucun service de messagerie. Le staff peut
copier l'adresse d'un élève ou les adresses dédupliquées d'une sélection dans le
presse-papiers, puis les coller dans l'outil de son choix. Aucun contenu de mail
n'est généré et aucun email n'est envoyé par Convex depuis cette page.

Son actualisation traite le snapshot des élèves du site club comme source de
vérité, avant l'annuaire des licences. La page affiche un délai de quatre heures par défaut pour
les élèves et les créneaux de 7 h et 9 h, heure de Paris, pour l'annuaire.
L'annuaire est limité à une tentative par créneau, uniquement à la demande
(voir [Synchronisations à la demande](5-module-abonnements.md#synchronisations-à-la-demande-convexabosyncts)).

Les correspondances possibles avec l'annuaire se chargent uniquement avec le
bouton « Afficher les correspondances possibles ». Le masquage arrête cet
abonnement ; la liste des élèves et le suivi manuel restent disponibles.
Le staff peut marquer temporairement une personne « traitée » après
avoir saisi sa licence sur le site club ; elle reste visible mais sort des
sélections de relance jusqu'à ce que la synchronisation confirme la licence. Ce
suivi est hors saison comptable et une licence réellement remontée par le site
reste toujours prioritaire sur le marqueur manuel.

`convex/crons.ts` est volontairement vide. Un cron ne doit être réintroduit que
si une donnée doit rester fraîche sans présence utilisateur, à cadence justifiée
et avec le commentaire requis `// CRON-OK: <raison>`.

Le calendrier officiel des samedis suit le même principe à la demande, sans
cron. Un gestionnaire déclenche la lecture des jours fériés métropolitains et
du calendrier scolaire de Grenoble (zone A). Un verrou partagé et une fenêtre
d'une heure évitent les appels concurrents ou répétés. En cas d'échec, le
dernier état connu reste affiché et les réservations demeurent fermées tant que
la configuration courante n'a pas été vérifiée avec succès.

Le planning salarié lit Google Calendar à la demande avec verrou et volumes
bornés. Une saga persistée applique ensuite chaque changement de ressource,
réessaie au plus trois fois et expose les échecs au gestionnaire. Les rappels
du lundi à 09 h sont des fonctions planifiées réconciliées après synchronisation ou
affectation, pas un cron. Voir
[13-planning-salaries-samedis.md](13-planning-salaries-samedis.md).

À l'ouverture de `/remboursements-eleves`, une action authentifiée actualise
indépendamment le snapshot des élèves et les deux formulaires HelloAsso dédiés
aux compétitions et aux stages. Chaque source utilise un verrou partagé d'une
heure et son échec n'empêche pas l'affichage du dernier cache. Le cache
HelloAsso conserve les paiements non rapprochés pendant 24 mois ; les paiements
plus anciens déjà rapprochés restent conservés pour l'audit des archives.

## Livraison

Un push sur `master` lance le workflow GitHub Actions :

```text
npm ci
  -> npx convex deploy
  -> npm run build
  -> publication de dist/ sur GitHub Pages
```

Les détails opérationnels et contrôles locaux sont décrits dans
[7-workflow.md](7-workflow.md).
