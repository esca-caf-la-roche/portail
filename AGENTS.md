# Instructions du projet esca-compta

## Source de vérité

`AGENTS.md` est la source canonique des instructions durables du dépôt.

Codex est l'unique environnement agentique maintenu dans le projet :

- rôles spécialisés : `.codex/agents/*.toml` ;
- hooks Codex : `.codex/hooks.json` et `.codex/hooks/` ;
- skills partagées : `.agents/skills/`.

## Projet

Portail de gestion d'un club d'escalade :

- frontend React 19, TypeScript 6, Vite 8 et React Router 7 ;
- backend, base temps réel et authentification avec Convex ;
- styles CSS natifs néo-brutalistes ;
- déploiement Convex et GitHub Pages depuis `master`.

Lire avant une modification structurelle :

- `docs/2-architecture.md` ;
- `docs/6-conventions.md` ;
- `docs/8-component-mapping.md`.

## Commandes

```bash
npm install
npx convex dev
npm run dev
npm run lint
npm run build
```

Le dépôt contient des tests Vitest, dont des tests Convex exécutés avec
`convex-test`. Ne jamais annoncer que des tests passent sans commande
correspondante. Suivre `docs/9-tests.md` pour le périmètre automatisé, la
validation manuelle et la stratégie d'introduction des tests.

## Convex : règles obligatoires

Avant toute modification dans `convex/`, lire intégralement
`convex/_generated/ai/guidelines.md`. Ces règles correspondent à la version
Convex utilisée par le projet et priment sur les connaissances générales.

Pour toute analyse de quota, de Database I/O, de volume d'appels ou de coût,
utiliser la skill `.agents/skills/convex-free-budget/SKILL.md`.

### Sécurité des endpoints

Tout nouvel endpoint applicatif doit utiliser :

- `authenticatedQuery` ;
- `authenticatedMutation` ;
- `authenticatedAction`.

Ces wrappers viennent de `convex/customFunctions.ts`. Ne pas utiliser directement
`query`, `mutation` ou `action` depuis `_generated/server` pour un endpoint
applicatif.

Exceptions :

- une fonction exclusivement serveur utilise `internalQuery`,
  `internalMutation` ou `internalAction` ;
- une surface volontairement publique porte
  `// PUBLIC: <justification>` immédiatement au-dessus de l'export.

Ajouter ensuite la garde métier appropriée depuis `convex/access.ts` ou
`convex/abo/auth.ts`.

### Accès par tuiles

L'accès à un module staff vient exclusivement de
`userSettings.allowedTiles`. Le rôle `admin` n'accorde aucun passe-droit sur les
tuiles ; il sert à l'administration des utilisateurs et des saisons.

Une tuile doit être protégée aux trois niveaux :

1. visibilité dans `src/pages/Dashboard.tsx` ;
2. route protégée par `src/components/RequireAccess.tsx` ;
3. endpoints protégés par `requireTile`, `requireAdmin` ou une garde Abonnements.

Le staff utilise `google-otp`. Les abonnés publics utilisent `abo-otp`, n'ont
pas de `userSettings` et restent isolés dans le module Abonnements.

Pour tout changement d'authentification, rôle, tuile ou autorisation, utiliser
la skill `.agents/skills/gestion-utilisateurs/SKILL.md`.

### Contrat de saison

Pour toute nouvelle tuile, table ou fonctionnalité métier, décider explicitement
si elle dépend d'une saison. Une table saisonnière doit avoir :

1. un champ `saison` ;
2. l'index `.index("by_saison", ["saison"])` ;
3. des requêtes utilisant cet index ;
4. une politique de suppression dans `convex/saisons.ts`.

Une exception doit porter `// SAISON-EXEMPT: <raison>`.
Utiliser la skill `.agents/skills/tuile-saison/SKILL.md`.

### Database I/O

Le budget Database I/O Convex est contraint.

1. Avant un `ctx.db.patch`, comparer avec `champsModifies` depuis
   `convex/dbUtils.ts`. Ne pas écrire si seules des dates techniques changent :
   l'écriture est facturée et invalide les abonnements temps réel.
2. Pour une source externe, préférer une synchronisation à la demande avec
   verrou partagé côté serveur, selon `convex/abo/sync.ts`.
3. Ne pas ajouter de cron périodique pour une synchronisation externe. Un cron
   réellement nécessaire doit fonctionner sans présence utilisateur, avoir une
   cadence mesurée et porter `// CRON-OK: <raison>`.
4. Utiliser les index, borner les lectures et traiter les volumes importants par
   pagination ou lots.
5. Mesurer DEV et PROD séparément avec `npm run audit:convex-io` avant de
   conclure qu'une hausse vient du trafic public. Le quota gratuit de 1 Go/mois
   est agrégé au niveau de l'équipe, tous projets et déploiements confondus.
6. Pour une validation automatisée, utiliser `npm run check:convex`, les tests,
   le lint et le build. Ne jamais lancer `convex dev --once` sur le DEV cloud
   comme simple typecheck ; un serveur de développement agentique utilise
   `convex dev --local` par défaut. Toute exception cloud doit être justifiée.
7. Une query React ne reçoit jamais `Date.now()` ou une valeur recréée à chaque
   rendu. Utiliser un argument stable, arrondi à la minute au maximum, et
   `"skip"` tant que les arguments utiles ne sont pas prêts.
8. Tout nouveau parcours complet de table porte `// IO-BOUNDED: <raison et
   volume maximal>` lorsqu'un index ou une pagination ne peut pas répondre au
   besoin. Le commentaire n'autorise pas un volume non borné.

## Rôles et skills Codex

Les rôles de `.codex/agents/` couvrent l'architecture, le produit, le frontend,
le backend Convex, les données, la sécurité, l'UX, la performance, la QA, la
revue, la documentation et Git/CI.

- Utiliser `architecte` avant l'implémentation d'une nouvelle fonctionnalité,
  tuile ou d'un nouveau module.
- Utiliser `data-engineer` pour tout changement de `convex/schema.ts` ou toute
  migration.
- Utiliser `dev-backend-convex` pour la logique serveur et `dev-frontend` pour
  l'interface.
- Après une implémentation significative, faire intervenir les contrôles
  pertinents : produit, sécurité, UX, performance, QA et revue de code.
- Ne pas déléguer une modification simple lorsque cela n'apporte aucune valeur.

La skill `.agents/skills/equipe/SKILL.md` orchestre ce workflow lorsque
l'utilisateur demande explicitement l'équipe ou plusieurs agents.

## Validation et livraison

### Discipline de branche

- Toute nouvelle fonctionnalité utilise une branche dédiée
  `codex/feat-<description>` ; toute correction utilise
  `codex/fix-<description>`.
- Avant un commit ou un push, comparer le nom et l'historique de la branche au
  périmètre demandé. Ne jamais réutiliser une branche active portant un autre
  sujet.
- Une branche empilée sur une branche non fusionnée doit être annoncée avec sa
  base de PR temporaire.

Avant de déclarer une modification terminée :

1. exécuter les contrôles proportionnés au changement ;
2. exécuter au minimum `npm run lint` et `npm run build` après une modification
   TypeScript significative ;
3. vérifier les droits et la saison pour les domaines concernés ;
4. mettre à jour la documentation affectée sans dupliquer l'information ;
5. signaler clairement les validations non exécutées.

La production Convex est normalement déployée par
`.github/workflows/deploy.yml` lors d'un push sur `master`. Ne pas lancer
`convex deploy` ou une commande mutante `--prod` sans demande ou confirmation
explicite de l'utilisateur.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
