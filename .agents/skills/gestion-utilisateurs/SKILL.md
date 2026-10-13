---
name: gestion-utilisateurs
description: Gestion des utilisateurs, rôles et accès de esca-compta (staff compta vs abonnés publics, tuiles allowedTiles, rôle admin, providers OTP). À utiliser pour TOUTE modification touchant l'authentification, les rôles, les droits d'accès, les tuiles du dashboard, la page Configurations, ou l'ajout d'un nouveau module/tuile.
---

# Gestion des utilisateurs — esca-compta

Modèle d'accès du projet. À lire AVANT de toucher à l'auth, aux rôles ou aux
accès. La règle d'or est en §2 — elle a déjà été violée une fois (bug corrigé
le 2026-07-02) et un hook (`.codex/hooks/check-access-control.mjs`) la fait
respecter.

## 1. Quatre parcours, quatre connexions distinctes

La table `users` (Convex Auth) est partagée par deux parcours distincts. Un
compte staff peut aussi porter un profil public lorsqu'un bénévole dépose une
demande personnelle avec la même adresse ; ce cas doit conserver les accès staff
lors du reset annuel.

| Population | Provider OTP | Marqueur et espace |
|---|---|---|
| Staff compta | `google-otp` | `userSettings`, portail `/` |
| Abonnés publics | `abo-otp` | `abo_profiles`, mini-app `/abonnements` |
| Participants aux permanences | `samedi-otp` | `samedis_participants`, mini-app `/samedis` |
| Salariés du planning samedi | `planning-salaries-otp` | `planning_salaries_annuaire`, mini-app `/planning-salaries-samedis` |

- `Layout.tsx` redirige tout connecté sans `userSettings` (non-staff) vers
  `/abonnements` : un abonné public ne doit jamais voir le portail compta.
- Un membre du staff peut faire une demande d'abonnement personnelle avec son
  compte existant. La purge annuelle doit alors supprimer seulement ses données
  de campagne et son `abo_profiles`, jamais son `users`, son `userSettings`, ses
  sessions ou ses comptes d'authentification.
- Ne jamais créer de `userSettings` pour un abonné public, ni d'`abo_profiles`
  "admin" (les admins abo sont dérivés côté serveur, voir §3).
- Ne jamais créer de `userSettings` pour un participant ou un salarié isolé.
  Une adresse du planning salarié ne peut pas devenir staff, et réciproquement :
  les deux mutations d'annuaire et d'administration doivent refuser la collision.
  Elle ne peut pas non plus cumuler `abo_profiles` ou `samedis_participants` :
  les créations/modifications et `createOrUpdateUser` refusent ces collisions
  dans les deux sens, car la session Convex est partagée par `userId`.

## 2. RÈGLE D'OR : les tuiles, rien que les tuiles

**L'accès à un module (tuile) vient UNIQUEMENT de
`userSettings.allowedTiles`, persistées côté serveur.
Le rôle `admin` ne donne AUCUN passe-droit sur les tuiles.**

- Interdit : `settings.role === "admin" || settings.allowedTiles.includes(...)`
  (c'est le bug historique — le hook bloque ce pattern).
- Le rôle `admin` sert exclusivement à administrer l'application : page
  `/configurations` (gestion des utilisateurs/accès + saisons) et bouton
  Configurations du Dashboard.
- Les tuiles facultatives se choisissent dans Configurations > Utilisateurs.
  `taches` est obligatoire pour tout staff, y compris un admin sans tuile
  facultative. L'attribution et le rattrapage idempotent sont décrits dans
  `docs/3-authentification.md` (section « Tuile obligatoire Tâches ») : conserver
  ce contrat lors de toute modification des utilisateurs, du bootstrap ou du Layout.

Tuiles existantes : `compta`, `paiements`, `budget`, `abonnements`,
`licences_cours`, `contacts_cours`, `remboursements_eleves`, `samedis`,
`planning_salaries_samedis`, `taches`
(source de vérité : `TILES` dans `convex/access.ts`, alignée avec
`TILE_OPTIONS` dans `src/pages/Configurations.tsx`).

## 3. Où vit chaque garde

Sécurité réelle = côté serveur. Le front ne fait que de l'affichage.

| Garde | Fichier | Usage |
|---|---|---|
| `authenticatedQuery/Mutation/Action` | `convex/customFunctions.ts` | OBLIGATOIRE pour tout endpoint (règle AGENTS.md). Fournit `ctx.userId`. |
| `requireTile(ctx, ctx.userId, tile)` | `convex/access.ts` | endpoint réservé à un module |
| `requireAdmin(ctx, ctx.userId)` | `convex/access.ts` | endpoints d'administration (users, saisons) |
| `getAboIdentity / requireAboAdmin / requireOwnedDossier` | `convex/abo/auth.ts` | module abonnements ; `aboRole="admin"` = tuile `abonnements` cochée, sinon "utilisateur" (abonné public ou staff sans la tuile) |
| `getIdentite / requireGestionnaire` | `convex/planningSalaries/lib.ts` | planning salarié ; gestionnaire par tuile, salarié par fiche active liée |
| `RequireAccess` (`tile=` ou `admin`) | `src/components/RequireAccess.tsx` | garde de route dans `App.tsx` (UX seulement, défense en profondeur) |
| Affichage des tuiles | `src/pages/Dashboard.tsx` | `allowedTiles.includes(...)` uniquement |

Endpoints volontairement publics (query brute de `_generated/server`) : ils
doivent porter un commentaire `// PUBLIC: <justification>` juste au-dessus de
l'export, sinon le hook bloque. Existants : `users.current`,
`users.checkEmailExists` (gate OTP pré-login), `abo.identity.me` (aiguillage),
`abo.compteur.compteurPublic` (iframe anonyme, ne renvoie que des entiers).

## 4. Bonnes pratiques Convex (rappel)

- Ne JAMAIS accepter un `userId` en argument pour de l'autorisation : toujours
  dériver l'identité côté serveur (`ctx.userId` des wrappers, ou
  `getAuthUserId(ctx)`).
- Vérifier l'autorisation dans CHAQUE endpoint, même si le front cache déjà la
  page : les fonctions publiques Convex sont appelables directement.
- `userSettings` se lit via l'index `by_userId` (pas de `.filter`).
- Dans Abonnements, filtrer les données par propriétaire sauf pour les admins du
  module (cf. `requireOwnedDossier`). Les autres modules suivent leur contrat :
  toutes les tâches de la saison sont visibles par tout le staff ; leurs
  mutations restent limitées selon `docs/16-taches.md`, sans bypass admin.

## 5. Checklist : ajouter un nouveau module / une nouvelle tuile

1. Ajouter l'id dans `TILES` (`convex/access.ts`) ET dans `TILE_OPTIONS`
   (`src/pages/Configurations.tsx`).
2. Créer les endpoints avec `authenticatedQuery/Mutation/Action` +
   `requireTile(ctx, ctx.userId, "<tuile>")`.
3. Ajouter la tuile dans `Dashboard.tsx` avec la condition
   `userSettings.allowedTiles?.includes("<tuile>")` (sans condition de rôle).
4. Garder la route dans `App.tsx` : `<RequireAccess tile="<tuile>">…`.
5. Cocher la tuile pour les comptes concernés dans Configurations >
   Utilisateurs (y compris les admins qui en ont besoin), sauf `taches`, imposée
   côté serveur pour tout staff.

## 6. Checklist : modifier les rôles / la page Configurations

- Toute mutation d'administration commence par `requireAdmin(ctx, ctx.userId)`.
- `listUsers` est admin-only (expose les emails de tout le staff).
- La suppression d'un utilisateur supprime aussi son `userSettings`
  (`users.removeUser`), mais doit être refusée s'il est encore référencé comme
  créateur ou assigné d'une tâche, même terminée.
- Ne pas introduire de nouveau rôle sans mettre à jour ce skill, `access.ts`
  et le hook.
