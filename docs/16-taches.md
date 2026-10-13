# Tâches du staff

La tuile `/taches` organise le travail partagé par saison. Son attribution
obligatoire au staff est décrite dans
[Authentification](3-authentification.md#tuile-obligatoire-tâches).

## Utilisation

Choisir la saison dans le header, puis consulter la liste paginée. Les filtres
par statut et personne assignée permettent de cibler le travail à suivre.
Chaque membre du staff voit toutes les tâches de la saison, même celles dont il
n'est ni créateur ni assigné, et peut créer une tâche.

Une tâche comporte :

- un titre obligatoire, limité à 160 caractères ;
- une description limitée à 4 000 caractères ;
- une échéance facultative, au format `YYYY-MM-DD` ;
- de 1 à 50 assignés appartenant au staff ;
- un statut global : `a_faire`, `en_cours` ou `terminee`.

## Droits et conservation

| Action | Personnes autorisées |
|---|---|
| Lire les tâches de la saison | Tout le staff |
| Modifier le contenu, l'échéance ou les assignations | Créateur uniquement |
| Supprimer une tâche | Créateur uniquement |
| Changer le statut global | Créateur ou l'un des assignés |

Le statut concerne la tâche entière, pas l'avancement individuel de chaque
assigné. Le rôle administrateur n'étend aucun de ces droits. Les comptes publics
ou isolés n'ont pas accès au module.

La suppression d'une saison contenant des tâches est bloquée, même si elles
sont terminées. La suppression d'un utilisateur encore référencé comme créateur
ou assigné est également bloquée. Il faut d'abord résoudre ces références :
retirer une assignation en conservant au moins un assigné, ou faire supprimer la
tâche par son créateur. Aucune purge implicite ne contourne ces droits.

## Notifications par e-mail

Lorsqu'une tâche est créée ou que de nouveaux assignés sont ajoutés, chaque
personne **nouvellement assignée** reçoit un e-mail de notification
(`internal.email.sendTacheEmail`, boîte du portail staff). L'auteur d'une tâche
n'est **jamais** notifié pour une auto-assignation. Réenregistrer une tâche sans
changer ses assignés n'envoie aucun e-mail ; un assigné sans adresse valide est
ignoré sans faire échouer l'enregistrement. L'envoi est planifié après la
transaction (jamais bloquant) et n'est pas rejoué automatiquement en cas
d'échec SMTP.

## Repères techniques et validation

`src/pages/Taches.tsx` utilise la saison sélectionnée ; `convex/taches.ts`
contrôle les autorisations et la validation serveur. Les tables `taches` et
`taches_assignations` portent la saison et l'index `by_saison` ; les lectures
restent indexées et paginées.

Les scénarios à exécuter sont regroupés dans le
[guide de tests](9-tests.md#scénarios-ciblés--tâches-du-staff). Cette documentation
décrit le contrat fonctionnel ; elle ne constitue pas un résultat de validation
ni une confirmation de déploiement.
