# Workflow de développement et de livraison

## Branches

`master` est la branche de production. Les changements sont développés sur une
branche dédiée, vérifiés localement, puis intégrés à `master`.

Les messages de commit récents suivent majoritairement une forme proche de
Conventional Commits :

```text
feat(domaine): ajoute une capacité
fix(domaine): corrige un comportement
perf(convex): réduit le Database I/O
chore(outillage): maintient la configuration
```

Le libellé doit décrire l'intention métier ou technique, pas seulement les
fichiers modifiés.

## Boucle locale

```bash
npm install
npx.cmd convex dev
npm run dev
```

Avant livraison :

```bash
npm run check:convex
npm test
npm run lint
npm run build
```

Le build exécute `tsc -b` avant Vite et contrôle le frontend. Il ne remplace pas
`npm run check:convex`, qui typecheck aussi les fonctions et tests Convex.
`npm test` exécute les tests Vitest actuels ; leur périmètre et les scénarios
manuels complémentaires sont documentés dans [9-tests.md](9-tests.md).

## Garde-fous du dépôt

Codex est l'environnement principal. Il charge les rôles spécialisés depuis
`.codex/agents/`, les skills métier depuis `.agents/skills/` et les hooks depuis
`.codex/hooks.json`.

Les hooks activent les contrôles suivants lors des modifications :

| Contrôle | Objet |
|---|---|
| `check-access-control.mjs` | Bloque un endpoint public injustifié et les passe-droits admin sur les tuiles |
| `check-saison-config.mjs` | Vérifie index et suppression des données saisonnières |
| `check-cron-justification.mjs` | Exige une justification pour tout nouveau cron |
| `check-convex-cloud-dev.mjs` | Empêche d'utiliser un déploiement DEV cloud comme simple contrôle de types |
| `check-convex-io.mjs` | Signale les écritures et parcours Convex à risque pour le budget I/O |
| `check-eslint.mjs` | Exécute ESLint sur les fichiers TypeScript modifiés |
| `check-prod-deploy.mjs` | Demande confirmation avant une mutation Convex en production |

Ces contrôles complètent la revue ; ils ne prouvent pas à eux seuls le bon
fonctionnement métier.

## Déploiement

Le workflow `.github/workflows/deploy.yml` se déclenche à chaque push sur
`master` :

```text
Checkout
  -> Node.js 24 + cache npm
  -> npm ci
  -> npx convex deploy
  -> npm run build
  -> dépôt de dist/
  -> GitHub Pages
```

Les secrets CI requis sont :

- `CONVEX_DEPLOY_KEY` pour déployer le backend ;
- `VITE_CONVEX_URL` pour construire le frontend.

Vite utilise la base `/portail/` et `HashRouter`, deux contraintes à
conserver pour GitHub Pages.

## Production Convex

La production est normalement modifiée par le workflow CI. Une commande
manuelle `convex deploy` ou une commande mutante avec `--prod` doit rester
exceptionnelle, être testée en développement et faire l'objet d'une confirmation
explicite. Après cette confirmation, le hook Codex attend le commentaire
`# PROD-OK: <raison>` dans la commande.

Les variables d'environnement sensibles sont configurées dans Convex. Ne jamais
les copier dans la documentation, les logs, un commit ou une capture d'écran.

L'archive des tests d'autonomie réutilise le compte de service Google Drive
existant (`GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL` et `GOOGLE_DRIVE_PRIVATE_KEY`).
Avant son premier essai sur un déploiement, configurer aussi les identifiants
non secrets du Drive partagé : `ABO_TESTS_DRIVE_ID` et
`ABO_TESTS_DRIVE_ROOT_FOLDER_ID`. Le compte de service doit avoir accès en
lecture et écriture au répertoire historique des tests ; ne pas remplacer ce
répertoire ni changer son classement alphabétique.

## Validation d'une fonctionnalité

1. Vérifier le parcours nominal et les erreurs attendues.
2. Tester les droits avec chaque population et chaque tuile concernée.
3. Vérifier le changement de saison si le domaine est saisonnier.
4. Contrôler les appels et écritures Convex pour éviter une amplification I/O.
5. Exécuter `npm run check:convex`, les tests pertinents, lint et build.
6. Mesurer DEV et PROD séparément avec `npm run audit:convex-io` lorsque le
   changement peut modifier les lectures ou écritures Convex.
7. Mettre à jour uniquement les sections documentaires affectées.

Les scénarios manuels propres aux Abonnements sont détaillés dans
[5-module-abonnements.md](5-module-abonnements.md).
