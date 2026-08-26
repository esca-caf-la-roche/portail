import { v } from "convex/values";
import { authenticatedQuery } from "../customFunctions";
import { getIdentiteOptionnelle } from "./lib";

export const me = authenticatedQuery({
  args: {},
  returns: v.object({
    gestionnaire: v.boolean(),
    salarie: v.union(
      v.null(),
      v.object({
        _id: v.id("planning_salaries_annuaire"),
        prenom: v.string(),
      }),
    ),
  }),
  handler: async (ctx) => {
    // Cette query sert aussi d'aiguillage dans Layout pour les autres
    // populations authentifiées. Une absence d'accès est donc un état normal,
    // pas une erreur métier.
    const identite = await getIdentiteOptionnelle(ctx, ctx.userId);
    return {
      gestionnaire: identite.gestionnaire,
      salarie: identite.salarie
        ? {
            _id: identite.salarie._id,
            prenom: identite.salarie.prenom,
          }
        : null,
    };
  },
});
