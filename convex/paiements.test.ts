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

describe("paiements.getDossiersTraitesIndex", () => {
  test("retourne uniquement la projection compacte des dossiers cours traités", async () => {
    const t = convexTest(schema, modules);
    const { staffId, groupeId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("users", { email: "staff-index@example.test" });
      await ctx.db.insert("userSettings", {
        userId: staffId,
        allowedTiles: ["paiements"],
        role: "user",
      });
      const groupeId = await ctx.db.insert("groups", {
        name: "Adultes",
        requires_approval: true,
      });
      const lienCoursId = await ctx.db.insert("helloasso_links", {
        url: "https://www.helloasso.com/associations/esca/adhesions/cours",
        label: "Cours",
        is_installment: false,
        type: "cours",
      });
      const lienAboId = await ctx.db.insert("helloasso_links", {
        url: "https://www.helloasso.com/associations/esca/adhesions/abonnements",
        label: "Abonnements",
        is_installment: false,
        type: "abonnement",
      });
      await ctx.db.insert("group_links", { group_id: groupeId, link_id: lienCoursId });
      const dossier = {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.test",
        payer_first_name: "Augusta",
        payer_last_name: "Lovelace",
        payer_email: "payer@example.test",
        total_amount: 120,
      };
      await ctx.db.insert("dossiers", {
        ...dossier,
        dossier_id: "cours-traite",
        helloasso_link_id: lienCoursId,
        local_status: "Traité",
      });
      await ctx.db.insert("dossiers", {
        ...dossier,
        dossier_id: "cours-attente",
        helloasso_link_id: lienCoursId,
        local_status: "En attente",
      });
      await ctx.db.insert("dossiers", {
        ...dossier,
        dossier_id: "abo-traite",
        helloasso_link_id: lienAboId,
        local_status: "Traité",
      });
      return { staffId, groupeId };
    });

    await expect(
      t.withIdentity({ subject: staffId }).query(api.paiements.getDossiersTraitesIndex, {}),
    ).resolves.toEqual([
      {
        payer_email: "payer@example.test",
        email: "ada@example.test",
        first_name: "Ada",
        last_name: "Lovelace",
        group_ids: [groupeId],
      },
    ]);
  });
});
