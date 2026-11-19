import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { archiveCollectionScope, archiveHref, parseArchiveCollection } from "../src/admin-archive.js";
import { CORE_AUTHOR_OPTION_ID } from "../src/collaborator-access.js";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  collection: { findMany: vi.fn() }, retailBatch: { count: vi.fn() },
  artwork: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  event: { findMany: vi.fn(), findFirst: vi.fn() }, ownershipTransfer: { findMany: vi.fn() }, $disconnect: vi.fn()
}));
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: { adminBasicUser: "admin", adminBasicPass: "password", releaseIntervalMinutes: 60 } }));
import { createServer } from "../src/server.js";
const headers = { authorization: `Basic ${Buffer.from("admin:password").toString("base64")}` };
const work = (id: string) => ({ iris_id: id, status: "assigned", assigned_order_id: null, collection_id: "okg",
  created_at: new Date("2026-11-18T12:00:00Z"), collection: { slug: "the-art-of-adornment", edition_size: 100 },
  owner_email: null, activated_at: null, image_url: null, pin_code: null, activation_token: "token", weight_grams: null, rarity_code: null });
let app: FastifyInstance;
beforeEach(async () => {
  vi.resetAllMocks();
  db.collection.findMany.mockResolvedValue([{ id: "okg", name: "OKG", slug: "the-art-of-adornment" },
    { id: "core", name: "IRIS", slug: "iris-the-unseen-edition" }]);
  db.retailBatch.count.mockResolvedValue(1);
  db.artwork.findMany.mockResolvedValue([]);
  db.artwork.findUnique.mockResolvedValue(work("OKG050"));
  db.event.findMany.mockResolvedValue([]);
  db.event.findFirst.mockResolvedValue(null);
  db.ownershipTransfer.findMany.mockResolvedValue([]);
  app = await createServer();
});
afterEach(async () => { await app.close(); });
const get = (url: string) => app.inject({ url, headers });

describe("admin archive collection filtering", () => {
  it("shows only the main collection by default and requires admin access", async () => {
    expect((await app.inject("/admin")).statusCode).toBe(401);
    expect(db.collection.findMany).not.toHaveBeenCalled();
    const response = await get("/admin");
    expect(response.statusCode).toBe(200);
    expect(db.artwork.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ collection_id: null }) }));
    expect(response.body).toContain(`value="${CORE_AUTHOR_OPTION_ID}" selected`);
    expect(response.body).toContain('value="all">All collections');
  });
  it("scopes selected collections, includes retail stock, and preserves filters across tabs and pages", async () => {
    db.artwork.findMany.mockResolvedValue(Array.from({ length: 22 }, (_, i) => ({ ...work(`OKG${String(i + 1).padStart(3, "0")}`), status: "retail_stock" })));
    const response = await get("/admin?collection=okg&q=OKG&status=unactivated");
    expect(response.statusCode).toBe(200);
    expect(db.artwork.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ collection_id: "okg", status: { in: ["assigned", "shopify_failed", "retail_stock"] } }));
    expect(response.body).toContain("Retail stock");
    expect(response.body).toContain("collection=okg&amp;q=OKG&amp;status=unactivated&amp;page=2");
    expect(response.body).toContain("collection=okg&amp;q=OKG&amp;status=activated");
    expect(response.body).toContain('name="collection" value="okg"');
  });
  it("supports all collections and rejects unknown choices", async () => {
    await get("/admin?collection=all");
    expect(db.artwork.findMany.mock.calls[0][0].where.collection_id).toBeUndefined();
    expect((await get("/admin?collection=unknown")).statusCode).toBe(400);
  });
  it("works during deployment before the retail migration", async () => {
    db.retailBatch.count.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "test" }));
    expect((await get("/admin?collection=okg")).statusCode).toBe(200);
    expect(db.artwork.findMany.mock.calls[0][0].where.status.in).not.toContain("retail_stock");
  });
  it("preserves collection context in detail navigation and back links", async () => {
    db.artwork.findMany.mockResolvedValue([work("OKG049"), work("OKG050"), work("OKG051")]);
    const response = await get("/admin/iris/OKG050?collection=okg&q=OKG&status=unactivated");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('/admin/iris/OKG049?collection=okg&amp;q=OKG&amp;status=unactivated');
    expect(response.body).toContain('/admin/iris/OKG051?collection=okg&amp;q=OKG&amp;status=unactivated');
    expect(response.body).toContain('href="/admin?collection=okg&amp;q=OKG&amp;status=unactivated">Back');
    expect(db.artwork.findMany.mock.calls[0][0].where.collection_id).toBe("okg");
  });
  it("parses defaults and builds encoded archive URLs", () => {
    expect(parseArchiveCollection(undefined)).toBe(CORE_AUTHOR_OPTION_ID);
    expect(archiveCollectionScope("all")).toEqual({});
    expect(archiveCollectionScope(CORE_AUTHOR_OPTION_ID)).toEqual({ collection_id: null });
    expect(archiveHref("okg", "a+b@x.test", "activated", 2)).toBe("/admin?collection=okg&q=a%2Bb%40x.test&status=activated&page=2");
  });
});
