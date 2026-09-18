---
name: convex-io-guard
description: Harden or review costly Convex read paths, subscriptions, and synchronizations in esca-compta before implementation or deployment.
---

# Convex Database I/O guard

Use this skill whenever a change touches a known costly Abonnements reader, a
batch import/synchronization, a materialized projection, or a query with a
large bounded collection. It supplements `convex-free-budget`; it does not
authorize a production deployment or a change to usage limits.

## Known costly paths

- `abo/licencesEnCours.getElevesLicenceInvalide`
- `abo/compteur.getElevesEnCours`
- `abo/compteur.rafraichirCompteurPublic`

For a new costly path, add it to the hook registry in
`.codex/hooks/check-convex-io.mjs` in the same change.

## Required decisions

1. State the table read set, maximum rows/bytes, and freshness requirement.
2. Keep a live `useQuery` only where pushed updates are a product requirement.
   Otherwise use `useQueryPonctuelle`, stable arguments, `"skip"` until ready,
   and an explicit refresh after a confirmed mutation or completed sync.
3. Do not make an expensive point-in-time query auto-refresh on window focus.
   Avoid mount-plus-post-sync double loads; use the `autoLoad` and `force`
   options deliberately.
4. For imported snapshots, read a compact indexed projection/digest. Preserve a
   WIDEN → MIGRATE → NARROW fallback until the backfill-complete marker changes.
5. Coalesce derived-cache rebuilds through the shared scheduler. A stale
   callback must not erase a newer invalidation marker.
6. Add or update a focused regression test for the read path and its writer.

## Acceptance before delivery

Read PROD and DEV usage with `node .agents/skills/convex-free-budget/scripts/report-usage.mjs --json` before and after a production observation window. Read
production insights for 72 hours. Report the measured change, not an inferred
saving. Run `npm run check:convex`, relevant tests, lint, and build.

Do not introduce a cron merely to refresh external data. Do not remove the
rollout fallback before the projection migration has completed in DEV and PROD.
