# Guide de tests et de validation

## État actuel

Le dépôt contient des tests Vitest, notamment les tests Convex
`convex/**/*.test.ts`, exécutés dans l'environnement `edge-runtime` avec
`convex-test`. Il n'y a pas encore de suite e2e navigateur.

Les tests automatisés ne remplacent pas les validations manuelles métier. La
checklist du module Abonnements dans
[5-module-abonnements.md](5-module-abonnements.md) reste une validation
manuelle complémentaire.

## Contrôles disponibles

```bash
npm test
npm run check:convex
npm run lint
npm run build

# Enchaîne les quatre contrôles ci-dessus.
npm run validate
```

| Commande | Ce qu'elle vérifie | Déploiement Convex |
| --- | --- | --- |
| `npm test` | Les tests Vitest exécutables, dont `convex/**/*.test.ts`. | Non |
| `npm run check:convex` | Le TypeScript du dossier `convex/`, y compris les tests Convex, via `convex typecheck` et `convex/tsconfig.json`. Cela détecte par exemple un nom d'index invalide dans un callback `withIndex` de `convex-test`. | Non |
| `npm run lint` | Les règles ESLint du dépôt. | Non |
| `npm run build` | Le typecheck frontend (`tsc -b`) puis le build Vite. Le `tsconfig.app.json` couvre `src/`; il ne remplace pas le typecheck Convex. | Non |
| `npm run validate` | La séquence locale complète : typecheck Convex, tests Vitest, lint, puis typecheck/build frontend. | Non |

`convex typecheck` est la commande fournie par la CLI Convex installée. Elle
exécute le même contrôle TypeScript des fonctions Convex (`tsc --noEmit`) que
le flux de déploiement, mais sans générer ni envoyer quoi que ce soit vers une
instance Convex. Son projet est `convex/tsconfig.json`, qui inclut
`./**/*` et exclut seulement `convex/_generated/` : les fichiers
`convex/**/*.test.ts` font donc partie du contrôle.

Un déploiement Convex n'est effectué que par une commande explicite telle que
`npx convex deploy` ou par la CI après un push ; aucune des commandes ci-dessus
ne déploie vers DEV ou PROD.

## Validation manuelle minimale

Pour tout changement fonctionnel :

1. tester le parcours nominal ;
2. provoquer au moins une erreur de validation ;
3. vérifier un utilisateur autorisé et un utilisateur refusé ;
4. changer de saison lorsque la fonctionnalité est saisonnière ;
5. recharger la page pour vérifier la persistance et les données temps réel ;
6. contrôler les affichages mobile et clavier pour une modification frontend ;
7. vérifier qu'une synchronisation externe répétée respecte son verrou.

Pour le module Abonnements, utiliser la checklist e2e de
[5-module-abonnements.md](5-module-abonnements.md).

### Scénario ciblé — Messagerie Abonnements

1. avec un compte public `abo-otp`, envoyer un message depuis le suivi d'un
   dossier ; avec un compte staff ayant la tuile `abonnements`, vérifier que le
   compteur de l'onglet « Messages » se met à jour sans rechargement ;
2. ouvrir « Messages » : la conversation doit être visible dans « À traiter »,
   indépendamment du statut du dossier, avec son nombre de messages non lus ;
3. ouvrir le fil, vérifier l'historique, répondre, puis vérifier côté compte
   public la réponse et la notification email associée ;
4. revenir dans « Toutes les conversations » et vérifier que le fil reste
   consultable après rechargement ; retirer ensuite la tuile à un compte staff
   et vérifier le refus de route et du compteur backend.

### Scénario ciblé — Règlements signés

Ce scénario est hors saison et se joue avec un compte staff possédant la tuile
`abonnements` :

1. depuis le suivi public d'une personne validée, ouvrir le formulaire DocuSeal
   `6GFLQa478G3Qwv` ; vérifier que l'étape reste « À faire » après la signature
   tant que le staff n'a pas confirmé la liaison ;
2. préparer une réponse webhook contenant `{ NOM, Prénom, id-drive }`, puis
   ouvrir **Règlements**. Vérifier la synchronisation automatique, l'apparition
   dans la file à rapprocher et l'ouverture du lien Drive ;
3. relancer plusieurs fois **Synchroniser les règlements** et vérifier qu'un
   même `id-drive` ne crée ni doublon ni écriture inutile. Sélectionner ensuite
   un candidat licence exact ou approchant et confirmer manuellement. Le suivi
   public doit passer à « Fait » pour cette licence et cette version ;
4. tenter de relier le même PDF à une autre licence, puis un autre PDF à la même
   licence/version : les deux doublons doivent être refusés ; vérifier aussi le
   refus d'un fichier hors du dossier racine ou non PDF ;
5. ouvrir le lien Drive depuis la file **À enregistrer**, effectuer
   l'enregistrement manuel sur le site du club, puis cliquer **Marquer
   enregistré sur le site**. La ligne passe dans **Enregistrés** sans écriture
   automatique sur le site externe ;
6. simuler une réponse `null`, un tableau vide, une chaîne contenant le JSON,
   un JSON invalide, un `id-drive` invalide et une panne HTTP : aucune réponse
   invalide ne doit créer de ligne ou exposer les identifiants Basic Auth ;
7. retirer la tuile `abonnements` au compte staff et vérifier le refus des
   queries, mutations et actions webhook/Drive. Changer ensuite la saison comptable et
   exécuter un reset Abonnements sur des données de test : la liaison et son
   historique doivent rester présents.

### Scénarios ciblés — Résolution de conflits entre dossiers Abonnements

Ces scénarios sont hors saison et doivent être joués avec un compte staff ayant
la tuile `abonnements` :

1. créer deux dossiers familiaux distincts contenant une personne portant la
   même licence ; vérifier que le conflit apparaît lors de l'association et dans
   la liste **Conflits de licence**, sans modification préalable des dossiers ;
2. ouvrir la résolution depuis chacun des deux points d'entrée et contrôler
   l'écran unique : les deux e-mails et chaque personne sous la forme nom,
   prénom, licence doivent être présents ; la personne doublon n'apparaît qu'une
   fois ;
3. conserver les deux dossiers et déplacer des personnes dans les deux sens.
   Vérifier qu'aucune personne ne peut rester sans dossier, que chaque dossier
   conservé reste non vide et qu'une seule personne porte la licence ;
4. placer des réservations, des messages et des entrées d'historique d'e-mails
   dans les deux dossiers. Lorsque les deux restent, les messages et journaux
   restent dans leur dossier ; les réservations suivent leur personne ;
5. répéter en conservant seulement A puis seulement B. Le
   dossier, les sessions et les identités d'authentification de l'ancien compte
   public doivent être supprimés ; son ancre technique inactive reste jusqu'au
   reset annuel. Une connexion `abo-otp` avec son ancien
   e-mail doit être refusée par un message générique, sans révéler l'adresse
   du dossier conservé, sans ouvrir ce compte et sans créer de nouveau dossier. L'adresse
   à utiliser doit figurer uniquement dans l'email de résolution ;
6. répéter avec le compte du dossier supprimé possédant aussi des accès staff. Vérifier que
   son compte, ses sessions, son `userSettings` et ses tuiles restent intacts,
   tandis que son profil et son ancien dossier publics disparaissent. Son
   historique attaché au propriétaire doit rester relié au compte staff ;
7. vérifier qu'une notification est préparée pour chacune des deux adresses :
   si les deux dossiers restent, chacune reçoit uniquement sa composition
   finale ; si un dossier disparaît, son adresse reçoit l'adresse conservée.
   Simuler l'échec d'un envoi et contrôler dans le suivi interne son statut, son
   nombre de tentatives et son erreur ; aucun bouton ni endpoint applicatif de
   relance ne doit être annoncé ;
8. comparer le snapshot du site club avant et après la résolution : aucune ligne,
   inscription ni statut externe ne doit être modifié, supprimé ou bloqué ;
9. enchaîner une résolution A → B puis B → C. Les connexions `abo-otp` avec A et B
   doivent être refusées par le même message générique, sans indiquer C ni
   authentifier sur C ;
10. changer la saison comptable puis recharger : le module et l'audit restent
    hors saison. Déclencher ensuite le reset Abonnements sur un jeu de test : les
    marqueurs d'e-mails de la campagne doivent être purgés, tandis que l'audit
    minimal des résolutions reste conservé.

### Scénarios ciblés — Contacts des cours

Ces scénarios sont manuels tant qu'aucune suite navigateur n'est installée :

1. attribuer `contacts_cours` à un compte staff, puis vérifier la tuile, la
   route `/contacts-cours` et l'absence du sélecteur de saison ;
2. retirer la tuile à un utilisateur, y compris administrateur, puis vérifier
   l'absence de la tuile, le refus de la route et le refus des endpoints ;
3. ouvrir la page avec un snapshot `abo_eleves_en_cours` disponible : vérifier
   la synchronisation à la demande de la seule source élèves, puis un second
   chargement respectant le verrou partagé ;
4. simuler l'échec de la source externe et vérifier que le dernier snapshot
   reste consultable avec un avertissement de fraîcheur ;
5. vérifier que les élèves en liste d'attente ne sont pas affichés, puis
   combiner la recherche nom/prénom avec les filtres cours, horaire et
   encadrant ; la recherche doit rester insensible à la casse et aux accents.
   Pour chaque facette, vérifier que les options tiennent compte de la recherche
   et des deux autres filtres, mais pas de sa propre sélection ; une sélection
   devenue impossible doit être automatiquement effacée ;
6. contrôler les priorités de contact : email et téléphone de l'élève, puis
   fallback vers le gestionnaire du dossier, enfin état « non renseigné ».
   Une valeur email contenant plusieurs adresses, un séparateur virgule ou
   point-virgule, ou un caractère de contrôle doit être refusée et ne jamais
   alimenter un brouillon Gmail ;
7. copier une adresse et ouvrir WhatsApp avec un numéro français normalisé :
   l'application doit s'ouvrir sur mobile et iPadOS tactile, tandis qu'un
   ordinateur doit ouvrir `https://web.whatsapp.com/send?phone=…` ; un numéro
   absent ou invalide doit désactiver l'action ;
8. filtrer un groupe contenant des emails dupliqués et des élèves sans email,
   puis ouvrir le brouillon Gmail : les adresses uniques doivent être en CCI et
   le paramètre `authuser` doit désigner
   `coursescalade@caflarochebonneville.fr`, sans appel d'envoi email côté
   serveur. Cliquer aussi sur un email individuel et vérifier le même compte
   Gmail avec l'adresse en destinataire principal.
9. avec 1 à 100 adresses valides uniques, cliquer sur « Copier les emails » et
   vérifier une copie directe, séparée par des virgules ; avec 101 adresses,
   vérifier la navigation vers `/contacts-cours/copier` et les lots de 99 ;
10. sur la page de copie, vérifier qu'une adresse est affichée par ligne, que le
    bloc n'est grisé qu'après une copie réussie, qu'un échec du presse-papiers ne
    le marque pas comme copié, puis recharger et revenir dans le même onglet :
    la progression doit être conservée ; modifier la sélection doit la remettre
    à zéro ;
11. ouvrir directement `/contacts-cours/copier` sans état de navigation : la
    page doit annoncer une sélection expirée. Vérifier aussi qu'aucun email
    n'apparaît dans l'URL, l'historique ou `sessionStorage`, et que cette page ne
    relance pas la synchronisation externe.

Le test Vitest `src/utils/contactsCours.test.ts` couvre le découpage pur aux
limites 0, 99, 100, 101, 198 et 199 emails, le branchement exact entre copie
directe (100) et page de lots (101), ainsi que l'invalidation de la progression
si l'ordre des destinataires change.

### Scénarios ciblés — Licences élèves en cours

1. ouvrir `/licences-cours` un lundi et vérifier l'ordre : hors tolérance de
   septembre en premier, puis lundi, mardi, etc., puis cours et élèves ;
2. cliquer sur l'action d'un élève et vérifier que son adresse unique est copiée
   dans le presse-papiers, sans ouverture de Gmail ;
3. vérifier que l'action affiche brièvement « Adresse copiée » et qu'un refus
   d'accès au presse-papiers produit un message d'erreur ;
4. sélectionner plusieurs élèves, dont deux partageant la même adresse : le
   résultat collectif doit contenir uniquement les adresses uniques, séparées
   par une virgule ;
5. vérifier qu'aucune fenêtre Google ou Gmail ne s'ouvre depuis cette page.

### Scénarios ciblés — Remboursements élèves

1. attribuer `remboursements_eleves` à un compte staff et vérifier la tuile, la
   route gardée et l'absence du sélecteur de saison ; retirer ensuite la tuile
   et vérifier le refus frontend et backend, y compris pour un administrateur ;
2. créer une demande avec un total non divisible puis avec un prix fixe :
   vérifier que la somme des centimes attribués correspond exactement au total
   et que l'instantané des élèves reste lisible après renouvellement de la
   source `abo_eleves_en_cours` ;
3. ouvrir la tuile deux fois et vérifier les verrous d'une heure pour les élèves
   et HelloAsso ; simuler l'échec de chaque source et vérifier que le dernier
   cache reste affiché avec un avertissement non bloquant ;
4. ouvrir un brouillon initial puis une relance : Gmail doit s'ouvrir dans un
   nouvel onglet avec `escalade@caflarochebonneville.fr`, le destinataire unique,
   l'objet, le montant restant et le bon lien compétition ou stage. Une adresse
   invalide ou multi-adresses doit désactiver l'action. La date affichée reste
   une préparation de brouillon, jamais une preuve d'envoi ;
5. vérifier une suggestion par email, nom et montant, puis valider
   explicitement le rapprochement. Tester un paiement partiel, plusieurs
   paiements partiels, un dépassement du solde, un paiement déjà lié, un statut
   `pending`, un remboursement partiel et un remboursement total ;
6. vérifier que seuls les paiements autorisés comptent dans la progression,
   qu'une demande n'est archivable que lorsque tous les bénéficiaires sont
   soldés, puis tester restauration, annulation avec motif et pagination des
   demandes et archives ;
7. contrôler au clavier et sur mobile le formulaire, la sélection d'élèves,
   les onglets, le panneau de rapprochement et le bouton « Afficher plus ».
   Vérifier que les élèves cochés restent visibles pendant une recherche, que
   les noms des deux parents sont conservés et servent à suggérer un paiement ;
   vérifier aussi la modification d'une demande active ;
8. ouvrir les brouillons collectifs initial et de relance : toutes les adresses
   valides doivent être uniquement en CCI, le message doit rester générique et
   les élèves soldés doivent être exclus de la relance ; archiver ensuite un
   paiement non rapproché et vérifier qu'il disparaît des deux listes de
   rapprochement sans être supprimé.

### Scénario ciblé — Configuration du tableau de bord

1. avec un compte administrateur, ouvrir Configurations → Tableau de bord,
   modifier l'ordre et la couleur de plusieurs tuiles, puis enregistrer ;
   vérifier le résultat après rechargement avec un autre compte staff ;
2. vérifier qu'un compte staff ne voit que ses tuiles autorisées, dans l'ordre
   global conservé, et que l'ordre ou la couleur ne lui donnent jamais accès à
   une route ou à des données non attribuées.

## Stratégie recommandée

Introduire les tests progressivement autour des règles métier les plus risquées,
sans bloquer leur adoption sur une couverture globale.

### Priorité 1 : fonctions pures

Commencer par les utilitaires sans dépendance réseau :

- `src/utils/paieCompute.ts` ;
- `src/utils/planning.ts` ;
- `src/abonnements/lib/tests.ts` ;
- normalisation et matching dans `convex/abo/lib.ts`.

Cas attendus : valeurs limites, arrondis, entrées vides, changements de saison
et doublons.

### Priorité 2 : fonctions Convex

Utiliser `convex-test` avec Vitest et l'environnement `edge-runtime`. Placer les
tests Convex près du backend, avec le schéma et le module map requis par Convex.

Les premiers scénarios devraient couvrir :

- refus d'un endpoint sans identité ;
- absence de passe-droit admin sur une tuile ;
- isolation entre staff et abonnés publics ;
- propriété d'un dossier et d'un fil de discussion ;
- idempotence des synchronisations et upserts ;
- suppression ou conservation des données lors d'un changement de saison.

### Priorité 3 : parcours navigateur

Ajouter ensuite quelques scénarios e2e ciblés :

- connexion OTP avec transport email simulé ;
- navigation selon les tuiles autorisées ;
- création puis consultation d'une transaction ;
- demande Abonnements, validation admin et suivi public.

Les appels SMTP, HelloAsso, Google Drive et site du club doivent être simulés.
Les tests automatisés ne doivent jamais dépendre des secrets ou des données de
production.

## Critère de fin

Une fonctionnalité est prête lorsque `npm run check:convex`, les tests
pertinents, lint et build passent, que ses scénarios manuels à risque ont été
exécutés et que la documentation reflète les limites réelles. Toute nouvelle
suite automatisée doit ajouter ici sa commande et son périmètre.
