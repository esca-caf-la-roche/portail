import { v } from "convex/values";

// INVARIANT D'ASSIGNATION (doit rester vrai après CHAQUE mutation) :
//   - `taches.assigneIds` et l'ensemble des `taches_assignations.userId`
//     liées à la tâche sont identiques ;
//   - chaque `taches_assignations.statut` est égal au `taches.statut` porté par
//     la tâche parente. Ce duplicat volontaire permet le filtre paginé par
//     personne ET statut via `by_saison_and_userId_and_statut`, sans perdre de
//     lignes après la page. Les deux sources sont donc mises à jour dans la
//     MÊME transaction (create/update/setStatus de convex/taches.ts).
export const statutTache = v.union(v.literal("a_faire"), v.literal("en_cours"), v.literal("terminee"));
export const contenuTache = v.object({
  titre: v.string(), description: v.optional(v.string()), echeance: v.optional(v.string()),
  assigneIds: v.array(v.id("users")),
});
export const tacheFields = contenuTache.extend({
  saison: v.string(), createurId: v.id("users"), statut: statutTache, updatedAt: v.number(),
});
export const tacheDoc = tacheFields.extend({ _id: v.id("taches"), _creationTime: v.number() });
