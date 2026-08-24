# Introduction au Portail de Gestion Escalade

Le projet « portail » est un portail global de gestion pour le club
d'escalade. Il réunit les outils staff et un parcours Abonnements public isolé.

L'objectif de cette application est de regrouper plusieurs « mini-outils »
(Comptabilité, Budget, Paiements, suivi des cours, remboursements élèves,
permanences des samedis après-midi et Abonnements) dans une même interface
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
   pré-enregistré. Les participants aux samedis utilisent leur propre liste
   d'accès et leur propre écran de connexion. Les abonnés peuvent s'auto-inscrire,
   mais restent isolés dans le module public Abonnements sans accès aux outils
   du staff.
4. **Base de données temps réel** : [Convex](https://convex.dev/) synchronise
   les modifications sans rechargement.

Le module **Samedis après-midi** organise une permanence par samedi et par
saison. Les participants autorisés choisissent une date libre depuis un
calendrier dédié ; le staff disposant de la tuile `samedis` configure la
période, les accès et les exceptions. Voir
[12-module-samedis.md](12-module-samedis.md).

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
