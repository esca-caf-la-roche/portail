import { v } from "convex/values";
import { authenticatedQuery } from "../customFunctions";
import { getSamediIdentity } from "./lib";

export const me = authenticatedQuery({
  args: {},
  returns: v.object({
    autorise: v.boolean(),
    gestionnaire: v.boolean(),
    participant: v.union(
      v.null(),
      v.object({
        _id: v.id("samedis_participants"),
        nom: v.string(),
        email: v.string(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const identity = await getSamediIdentity(ctx, ctx.userId);
    return {
      autorise: identity?.gestionnaire === true || identity?.participant !== null,
      gestionnaire: identity?.gestionnaire ?? false,
      participant: identity?.participant
        ? {
            _id: identity.participant._id,
            nom: identity.participant.nom,
            email: identity.participant.email,
          }
        : null,
    };
  },
});
