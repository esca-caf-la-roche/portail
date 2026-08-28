# Portail Escalade CAF LRB

Portail de gestion du club d'escalade. L'application regroupe dans une interface
unique la comptabilité, les paiements, le budget prévisionnel, le contrôle des
licences, les remboursements des élèves, le planning Google des salariés du
samedi et les abonnements aux créneaux autonomes.

## Stack

- React 19, TypeScript 6 et Vite 8
- React Router 7 avec routage par hash, compatible GitHub Pages
- Convex pour les données temps réel, les fonctions serveur et l'authentification
- CSS natif selon un design system néo-brutaliste

L'architecture détaillée est décrite dans
[`docs/2-architecture.md`](docs/2-architecture.md).

## Prérequis

- Node.js 20, version utilisée par le workflow de production
- Un déploiement Convex accessible

## Installation et démarrage

```bash
npm install
npx convex dev
```

Dans un second terminal :

```bash
npm run dev
```

Le client attend `VITE_CONVEX_URL` dans `.env.local`. Les secrets SMTP,
HelloAsso, Google Drive et d'accès au site du club doivent être enregistrés dans
les variables d'environnement Convex, jamais dans le dépôt.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | Démarre le serveur Vite local |
| `npm run build` | Vérifie TypeScript puis produit le build Vite |
| `npm run lint` | Exécute ESLint sur le projet |
| `npm run preview` | Prévisualise le build de production |
| `npx convex dev` | Synchronise le backend Convex de développement |

Les tests Vitest et Convex s'exécutent avec `npm test` ; `npm run validate`
enchaîne le typecheck Convex, les tests, le lint et le build. Voir
[`docs/9-tests.md`](docs/9-tests.md) pour leur périmètre et les validations
manuelles complémentaires.

## Accès et sécurité

Deux populations utilisent la même base sans partager les mêmes droits :

- le staff se connecte avec le provider OTP `google-otp` et reçoit ses tuiles via
  `userSettings.allowedTiles` ;
- les abonnés publics utilisent `abo-otp` et restent isolés dans
  `/#/abonnements`.

Tout nouvel endpoint applicatif Convex doit utiliser les fonctions authentifiées
de `convex/customFunctions.ts`. Les exceptions publiques ou internes doivent
être explicites et justifiées. Voir
[`docs/3-authentification.md`](docs/3-authentification.md) et
[`docs/6-conventions.md`](docs/6-conventions.md).

## Documentation

| Document | Contenu |
|---|---|
| [`docs/1-introduction.md`](docs/1-introduction.md) | Objectifs et démarrage |
| [`docs/2-architecture.md`](docs/2-architecture.md) | Architecture technique |
| [`docs/3-authentification.md`](docs/3-authentification.md) | Authentification et accès |
| [`docs/4-design-system.md`](docs/4-design-system.md) | Identité visuelle |
| [`docs/5-module-abonnements.md`](docs/5-module-abonnements.md) | Module Abonnements |
| [`docs/6-conventions.md`](docs/6-conventions.md) | Conventions de développement |
| [`docs/7-workflow.md`](docs/7-workflow.md) | Livraison et contrôles |
| [`docs/8-component-mapping.md`](docs/8-component-mapping.md) | Cartographie des modules |
| [`docs/9-tests.md`](docs/9-tests.md) | Tests et validation |
| [`docs/10-remboursements-eleves.md`](docs/10-remboursements-eleves.md) | Suivi des remboursements élèves |
| [`docs/12-module-samedis.md`](docs/12-module-samedis.md) | Carnet de réservation de la salle le samedi après-midi |
| [`docs/13-planning-salaries-samedis.md`](docs/13-planning-salaries-samedis.md) | Planning Google des salariés du samedi |

## Déploiement

Un push sur `master` déclenche `.github/workflows/deploy.yml` : installation
reproductible avec `npm ci`, déploiement Convex, build Vite puis publication sur
GitHub Pages sous `/portail/`.
