/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("paiements.getResponsibles", () => {
  test("retourne uniquement le staff ayant la tuile Paiements", async () => {
    const t = convexTest(schema, modules);
    const { staffId, staffWithoutTileId, publicUserId } = await t.run(
      async (ctx) => {
        const staffId = await ctx.db.insert("users", {
          name: "Responsable staff",
          email: "staff@example.test",
        });
        await ctx.db.insert("userSettings", {
          userId: staffId,
          allowedTiles: ["paiements"],
          role: "user",
        });
        const staffWithoutTileId = await ctx.db.insert("users", {
          name: "Admin sans Paiements",
          email: "admin-sans-paiements@example.test",
        });
        await ctx.db.insert("userSettings", {
          userId: staffWithoutTileId,
          allowedTiles: ["compta"],
          role: "admin",
        });
        const publicUserId = await ctx.db.insert("users", {
          email: "abonne@example.test",
        });
        return { staffId, staffWithoutTileId, publicUserId };
      },
    );

    const staff = t.withIdentity({ subject: staffId });
    const responsibles = await staff.query(api.paiements.getResponsibles, {});

    expect(responsibles).toEqual([
      {
        id: staffId,
        name: "Responsable staff",
        is_superuser: false,
      },
    ]);
    expect(responsibles.some(({ id }) => id === staffWithoutTileId)).toBe(false);
    expect(responsibles.some(({ id }) => id === publicUserId)).toBe(false);
  });
});
