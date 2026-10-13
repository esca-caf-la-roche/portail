---
name: tuile-saison
description: Contrat "saison" de esca-compta — à utiliser pour TOUTE nouvelle tuile / module / feature, ou toute nouvelle table Convex. Force la décision "cette feature est-elle soumise à la saison ?" puis câble correctement le backend (champ saison + index by_saison + cascade de suppression), le sélecteur de saison du header et le front (useSeason). Complète le skill gestion-utilisateurs (tuiles/accès).
---

# Contrat « saison » — esca-compta

À lire AVANT de créer une nouvelle tuile / module / feature, ou une nouvelle
table Convex. Objectif : une configuration propre qui marche du premier coup,
sans « Server Error » ni sélecteur de saison incohérent.

Ce skill complète `gestion-utilisateurs` (accès/tuiles). Ordre conseillé :
d'abord la décision saison (ici), puis la checklist tuile
(`gestion-utilisateurs` §5).

## 0. QUESTION OBLIGATOIRE — à poser AVANT de coder

> **« Cette feature/tuile est-elle soumise à la saison ? »**
> (c.-à-d. ses données changent-elles d'une saison à l'autre — 2025-26,
> 2026-27… — et l'utilisateur doit-il pouvoir basculer de saison via le
> sélecteur du header ?)

Ne jamais deviner : poser la question à l'utilisateur (AskUserQuestion) si ce
n'est pas explicite. La réponse détermine tout le câblage ci-dessous.

Repères pour aider à trancher :

| Soumis à la saison (OUI) | Hors saison (NON) |
|---|---|
| Comptabilité (`compta`), Budget prévisionnel (`budget`), prévisionnels, masse salariale, cours | Paiement des cours (`paiements`), Abonnements escalade (`abonnements`) |
| Les données sont saisies/rejouées chaque saison | Données transverses / temps réel, indépendantes de la saison |
| L'utilisateur compare N-1 / N via le sélecteur | Le sélecteur n'a pas de sens (masqué) |

## 1. Si la feature EST soumise à la saison

### Backend (Convex)
1. **Schéma** (`convex/schema.ts`) : chaque table saisonnière porte
   `saison: v.string()` ET l'index `.index("by_saison", ["saison"])`.
   Le hook `check-saison-config.mjs` BLOQUE une table avec un champ `saison`
   sans cet index.
2. **Requêtes** : toujours filtrer par saison via l'index, jamais `.filter()` :
   `ctx.db.query("maTable").withIndex("by_saison", q => q.eq("saison", args.saison)).collect()`.
   La `saison` est un argument de l'endpoint (le front la passe), pas une
   valeur dérivée côté serveur.
3. **Suppression de saison** (`convex/saisons.ts` → `remove`) : déclarer la
   politique de la nouvelle table. Deux cas :
   - **Donnée « réelle » saisie à la main** (comme `transactions` / lignes de
     prévisionnel manuelles) → ajouter un garde qui REFUSE la suppression tant
     que la table contient des lignes (avec `ConvexError`).
   - **Donnée dérivée/rejouée** (comme `parametresPaie`, `salairesSaison`,
     `cours`, `budgetEffectifs`) → l'ajouter au type `SaisonTable` et à la
     cascade `deleteBySaison(...)` pour nettoyer les orphelins.
   Le hook BLOQUE si une table `by_saison` n'apparaît nulle part dans
   `saisons.ts`.
4. **Erreurs** : lever des `ConvexError` (pas `Error`). En production Convex
   masque le message des `Error` (« Server Error ») ; la charge d'une
   `ConvexError` est transmise au client (`error.data`). Côté front, lire
   `error.data` (helper `errMessage` dans `Configurations.tsx`).

### Front
5. **Sélecteur de saison** : il est affiché PAR DÉFAUT (`Layout.tsx`). Une
   feature saisonnière ne doit donc RIEN modifier ici — vérifier juste que sa
   route n'est pas dans la liste d'exclusion (`showSeasonSelector`).
6. **Lecture de la saison** : `const { season } = useSeason();`
   (`src/contexts/SeasonContext.tsx`) puis passer `season` à chaque query/
   mutation. Afficher la saison courante dans l'en-tête de page
   (`<p className="subtitle">Saison : {season}</p>`).

## 2. Si la feature N'EST PAS soumise à la saison

1. **Masquer le sélecteur** : ajouter le préfixe de route à la liste
   d'exclusion dans `src/components/Layout.tsx` :
   `const showSeasonSelector = !location.pathname.startsWith("/paiements") && !location.pathname.startsWith("/ma-route");`
   (ou refactorer en tableau de préfixes si la liste grandit).
2. **Backend** : ne PAS ajouter de champ `saison` ni d'index `by_saison` « au
   cas où ». Si une table a besoin d'un champ nommé `saison` comme simple
   donnée (ex. archives `abo_*`), ce n'est PAS une table saisonnière : ajouter
   un commentaire `// SAISON-EXEMPT: <raison>` sur la ligne du champ pour que
   le hook ne la bloque pas.
3. Aucun usage de `useSeason()`.

## 3. Câblage commun tuile/accès (rappel — voir gestion-utilisateurs §5)

Quelle que soit la réponse saison, une nouvelle tuile exige aussi :
1. l'id dans `TILES` (`convex/access.ts`) ET `TILE_OPTIONS`
   (`src/pages/Configurations.tsx`) ;
2. endpoints via `authenticatedQuery/Mutation/Action` + `requireTile(...)` ;
3. la tuile dans `Dashboard.tsx` (`allowedTiles?.includes("<tuile>")`, sans
   condition de rôle) ;
4. la route gardée dans `App.tsx` (`<RequireAccess tile="<tuile>">…`) ;
5. cocher la tuile pour les comptes concernés dans Configurations. Pour la
   tuile obligatoire `taches`, l'attribution est persistée automatiquement pour
   tout le staff selon `docs/3-authentification.md` ; elle n'est pas révocable.
6. **si la tuile rafraîchit des données externes** (scrap, API, import
   récurrent) : synchro **on-demand throttlée** (`convex/abo/sync.ts` : verrou
   partagé dans `abo_app_config`, TTL ~1 h), **jamais** un cron horaire ; et
   **upserts idempotents** (`champsModifies` de `convex/dbUtils.ts`, ne pas
   réécrire sur un simple tampon de date). Voir AGENTS.md § DATABASE I/O.

## 4. Checklist finale (copier/cocher)

Feature soumise à la saison :
- [ ] Table(s) avec `saison: v.string()` + `.index("by_saison", ["saison"])`
- [ ] Requêtes filtrées via `withIndex("by_saison", …)`
- [ ] Politique de suppression déclarée dans `saisons.ts` (garde OU cascade)
- [ ] `ConvexError` (pas `Error`) dans les endpoints
- [ ] `useSeason()` côté front, `season` passée aux queries
- [ ] Route hors liste d'exclusion du sélecteur (`Layout.tsx`)
- [ ] Checklist tuile/accès (§3)

Feature hors saison :
- [ ] Préfixe de route ajouté à `showSeasonSelector` (`Layout.tsx`)
- [ ] Aucun champ `saison`/index `by_saison` inutile (sinon `// SAISON-EXEMPT:`)
- [ ] Pas de `useSeason()`
- [ ] Checklist tuile/accès (§3)
