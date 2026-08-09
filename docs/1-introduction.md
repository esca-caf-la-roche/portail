# Introduction au Portail de Gestion Escalade

Le projet « portail » est un portail global de gestion pour le club
d'escalade. Il réunit les outils staff et un parcours Abonnements public isolé.

L'objectif de cette application est de regrouper plusieurs « mini-outils »
(Comptabilité, Budget, Paiements, suivi des cours, remboursements élèves et
Abonnements) dans une même interface centralisée, sécurisée et à la charte
graphique néo-brutaliste. Les routes Adhérents, Événements et Statistiques sont
pour l'instant des espaces réservés, sans module métier associé.

## Fonctionnalités Principales

1. **Dashboard centralisé** : un point d'entrée unique liste les outils staff
   autorisés sous forme de tuiles.
2. **Saisonnalité explicite** : les outils comptables utilisent la saison
   sélectionnée ; les parcours qui doivent rester consultables (Abonnements,
   tests d'autonomie, remboursements élèves) déclarent explicitement leur
   exception.
3. **Sécurité par OTP** : le staff accède au portail si son email a été
   pré-enregistré. Les abonnés peuvent s'auto-inscrire, mais restent isolés dans
   le module public Abonnements sans accès aux outils du staff.
4. **Base de données temps réel** : [Convex](https://convex.dev/) synchronise
   les modifications sans rechargement.

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
