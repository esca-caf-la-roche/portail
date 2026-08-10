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
  +-- fonctions publiques limitées à l'auth et au portail Abonnements
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
| Public | `/login`, `/abonnements`, `/compteur` | Selon le parcours |
| Staff | `/`, `/compta`, `/paiements`, `/budget`, `/licences-cours`, `/contacts-cours`, `/remboursements-eleves` | `Layout` puis `RequireAccess` |
| Administration | `/configurations`, `/gestion-abonnements` | Rôle admin ou tuile dédiée |

Le routage par hash permet de servir toutes les routes depuis GitHub Pages sans
réécriture serveur. L'affichage d'une tuile dans le tableau de bord ne constitue
pas à lui seul une autorisation : `RequireAccess` protège aussi la route, et le
backend contrôle les droits avant d'accéder aux données.

L'ordre, la couleur, le libellé et la description des tuiles du tableau de bord
sont des préférences globales, hors saison, administrables depuis Configurations.
Elles ne modifient jamais les autorisations : celles-ci restent définies
uniquement par `allowedTiles`.

Les styles globaux sont dans `src/index.css`. Le module Abonnements complète ces
règles avec `src/abonnements/abo.css` ; le design n'est donc plus contenu dans un
fichier CSS unique.

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
`convex/abo/` isole le domaine Abonnements. Les fonctions réutilisables de
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

Voir [3-authentification.md](3-authentification.md) pour les deux populations et
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

Les relations et index sont définis dans `convex/schema.ts`. Les collections
potentiellement volumineuses doivent être bornées, paginées ou parcourues par
lots conformément aux règles Convex du projet.

## Synchronisations externes

Les synchronisations HelloAsso, site du club, annuaire des licences et élèves en
cours sont déclenchées à la demande depuis les pages concernées. L'orchestrateur
`convex/abo/sync.ts` utilise un verrou partagé côté serveur, avec une fenêtre
d'environ une heure, pour éviter les appels et écritures répétés.

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

`convex/crons.ts` est volontairement vide. Un cron ne doit être réintroduit que
si une donnée doit rester fraîche sans présence utilisateur, à cadence justifiée
et avec le commentaire requis `// CRON-OK: <raison>`.

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
