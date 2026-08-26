# Introduction au Portail de Gestion Escalade

Le projet « portail » est un portail global de gestion pour le club
d'escalade. Il réunit les outils staff et un parcours Abonnements public isolé.

L'objectif de cette application est de regrouper plusieurs « mini-outils »
(Comptabilité, Budget, Paiements, suivi des cours, remboursements élèves,
permanences des samedis après-midi, planning des salariés du samedi et
Abonnements) dans une même interface
centralisée, sécurisée et à la charte graphique néo-brutaliste. Les routes
Adhérents, Événements et Statistiques sont pour l'instant des espaces réservés,
sans module métier associé.

## Fonctionnalités Principales

1. **Dashboard centralisé** : un point d'entrée unique liste les outils staff
   autorisés sous forme de tuiles.
2. **Saisonnalité explicite** : les outils comptables utilisent la saison
   sélectionnée ; les parcours qui doivent rester consultables (Abonnements,
   tests d'autonomie, remboursements élèves) déclarent explicitement leur
   exception.
3. **Sécurité par OTP** : le staff accède au portail si son email a été
   pré-enregistré. Les participants aux permanences et les salariés du samedi
   utilisent chacun leur liste d'accès et leur écran de connexion dédiés. Les abonnés peuvent s'auto-inscrire,
   mais restent isolés dans le module public Abonnements sans accès aux outils
   du staff.
4. **Base de données temps réel** : [Convex](https://convex.dev/) synchronise
   les modifications sans rechargement.

Le module **Samedis après-midi** organise une permanence par samedi et par
saison. Les participants autorisés choisissent une date libre depuis un
calendrier dédié ; le staff disposant de la tuile `samedis` configure la
période, les accès et les exceptions. Voir
[12-module-samedis.md](12-module-samedis.md).

Le module **Planning des salariés du samedi** importe depuis Google Calendar
les groupes de chaque samedi depuis les calendriers de ressources, puis remplace
« À déterminer » sur tous les événements de la date lorsqu'un salarié prend le
samedi. Il partage les compteurs de répartition avec l'équipe. Son
annuaire et son OTP sont isolés du portail staff. Voir
[13-planning-salaries-samedis.md](13-planning-salaries-samedis.md).

## Prérequis

- **Node.js** compatible avec les dépendances du projet ; la livraison continue
  utilise Node.js 24
- **Convex CLI** (installé via npm)

## Démarrage Rapide

1. Installez les dépendances :
   ```bash
   npm install
   ```
2. Démarrez le backend Convex dans un terminal :
   ```bash
   npx.cmd convex dev
   ```
3. Démarrez l'application frontend React/Vite dans un autre terminal :
   ```bash
   npm run dev
   ```
