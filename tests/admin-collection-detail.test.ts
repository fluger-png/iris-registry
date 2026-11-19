import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { adminCollectionsCsrf } from "../src/storefront-collections.js";
import { buildAdminCollectionsBody } from "../src/admin-collections.js";
import type { PartnerCollectionView } from "../src/partner-collections.js";
import { collectionPricing } from "../src/shopify-product-pricing.js";

const db = vi.hoisted(() => ({
  collection: { findUnique: vi.fn(), findMany: vi.fn() },
  collectionPresentation: { findUnique: vi.fn() }, collectionProductMedia: { findUnique: vi.fn() },
  collaboratorUser: { findMany: vi.fn() },
  retailBatch: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() }, retailBatchItem: { findMany: vi.fn() },
  artwork: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  event: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() }, ownershipTransfer: { findMany: vi.fn() },
  $queryRaw: vi.fn(), $transaction: vi.fn(), $disconnect: vi.fn()
}));
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: { adminBasicUser: "admin", adminBasicPass: "password", releaseIntervalMinutes: 60 } }));
vi.mock("../src/shopify-product-pricing.js", async () => ({ ...await vi.importActual("../src/shopify-product-pricing.js"),
  collectionPricing: { inspect: vi.fn().mockResolvedValue({ ready: false }) }
}));
import { createServer } from "../src/server.js";
const auth = { authorization: `Basic ${Buffer.from("admin:password").toString("base64")}` };
const headers = { ...auth, "content-type": "application/x-www-form-urlencoded" };
const okg = { id: "okg", slug: "the-art-of-adornment", name: "THE ART OF ADORNMENT", artist_name: "OKG Jewelry", edition_size: 100,
  shopify_handle: null, shopify_product_id: null, default_price_cents: 30000 };
const core = { ...okg, id: "core", slug: "iris-the-unseen-edition", name: "IRIS", artist_name: "IRIS", edition_size: 10000 };
const reference = "OKG-RETAIL-002";
const selected = [{ iris_id: "OKG009" }, { iris_id: "OKG090" }];
const work = (id: string) => ({ iris_id: id, status: "retail_stock", assigned_order_id: null, collection_id: "okg",
  created_at: new Date("2026-11-18T12:00:00Z"), collection: { slug: okg.slug, edition_size: 100 },
  owner_email: null, activated_at: null, image_url: null, pin_code: "123456", activation_token: "token", weight_grams: null, rarity_code: null });
let app: FastifyInstance;
const mkdir = vi.spyOn(fs, "mkdir");
const write = vi.spyOn(fs, "writeFile");
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(collectionPricing.inspect).mockResolvedValue({ ready: false, message: "Unavailable" });
  mkdir.mockResolvedValue(undefined);
  write.mockResolvedValue(undefined);
  db.$transaction.mockImplementation((fn) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.collection.findUnique.mockImplementation(({ where }) => Promise.resolve(where.id === "okg" ? okg : where.id === "core" ? core : null));
  db.collection.findMany.mockResolvedValue([okg, core]);
  db.collectionPresentation.findUnique.mockResolvedValue(null);
  db.collectionProductMedia.findUnique.mockResolvedValue(null);
  db.collaboratorUser.findMany.mockResolvedValue([]);
  db.retailBatch.count.mockResolvedValue(1);
  db.retailBatch.findMany.mockResolvedValue([]);
  db.retailBatch.findUnique.mockResolvedValue(null);
  db.retailBatch.create.mockResolvedValue({ id: reference, items: selected });
  db.retailBatchItem.findMany.mockResolvedValue([]);
  db.artwork.count.mockImplementation(({ where }) => Promise.resolve(where.status === "retail_stock" ? 25 : 75));
  db.artwork.findMany.mockImplementation(({ select }) => Promise.resolve(select?.status ? [] : [work("OKG004")]));
  db.artwork.findUnique.mockResolvedValue(work("OKG004"));
  db.artwork.updateMany.mockResolvedValue({ count: 1 });
  db.event.findMany.mockResolvedValue([]);
  db.event.findFirst.mockResolvedValue(null);
  db.ownershipTransfer.findMany.mockResolvedValue([]);
  app = await createServer();
});
afterEach(async () => { await app.close(); });
const get = (url: string) => app.inject({ url, headers: auth });
const post = (quantity: string, extra: Record<string, string> = {}, id = "okg") => app.inject({ method: "POST", url: `/admin/collections/${id}/retail`, headers,
  payload: new URLSearchParams({ csrf_token: adminCollectionsCsrf("password", Date.now()), reference, quantity, ...extra }).toString() });

describe("collection details", () => {
  it("requires global admin credentials, never just a partner login", async () => {
    for (const url of ["/admin/collections/okg", "/admin/collections/okg/retail"]) {
      const response = await app.inject({ method: url.endsWith("retail") ? "POST" : "GET", url, headers: { cookie: "iris_partner_session=test" } });
      expect(response.statusCode).toBe(401);
    }
    expect(db.collection.findUnique).not.toHaveBeenCalled();
  });
  it("links each collection mini-banner and title to its own details", () => {
    const view = { collection: okg, presentation: { record: { banner_url: "https://images.test/banner.jpg" }, available: true },
      product: null, purchased: 0, activated: 0 } as unknown as PartnerCollectionView;
    const html = buildAdminCollectionsBody([view], { ids: [], revision: 0, available: true }, "csrf", (v) => v);
    expect(html).toContain('class="collection-admin-identity" href="/admin/collections/okg"');
    expect(html).toMatch(/<a class="collection-admin-identity"[^>]+>[\s\S]*?<img[\s\S]*?<strong>THE ART OF ADORNMENT<\/strong>[\s\S]*?<\/a>/);
  });
  it("shows stats, bounds the quantity, and embeds the same scoped IRIS archive table", async () => {
    const response = await get("/admin/collections/okg?collection=all");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain("<h1>THE ART OF ADORNMENT</h1>");
    expect(response.body).toContain("Available</span><strong>75</strong>");
    expect(response.body).toContain("Retail Stock</span><strong>25</strong>");
    expect(response.body).toContain('name="quantity" min="1" max="75"');
    expect(response.body).toContain('action="/admin/collections/okg/retail"');
    expect(response.body).toContain('action="/admin/collections/okg"');
    expect(response.body).toContain("from_collection=okg");
    expect(response.body).toContain("<th>PIN</th>");
    expect(response.body).not.toContain('id="archive-collection"');
    const archive = db.artwork.findMany.mock.calls.find(([args]) => args.include?.collection);
    expect(archive?.[0].where.collection_id).toBe("okg");
    expect(archive?.[0].where.status.in).not.toContain("available");
  });
  it("keeps search and pagination on collection details and returns there from an IRIS", async () => {
    db.artwork.findMany.mockResolvedValue(Array.from({ length: 22 }, (_, i) => work(`OKG${String(i + 1).padStart(3, "0")}`)));
    const response = await get("/admin/collections/okg?q=OKG&status=unactivated");
    expect(response.body).toContain('/admin/collections/okg?collection=okg&amp;q=OKG&amp;status=unactivated&amp;page=2');
    const detail = await get("/admin/iris/OKG004?collection=okg&from_collection=okg");
    expect(detail.body).toContain('href="/admin/collections/okg?collection=okg">Back');
    expect(detail.body).toContain("from_collection=okg");
  });
  it("uses the legacy NULL artwork pool for main IRIS, never other collections", async () => {
    await get("/admin/collections/core");
    expect(db.artwork.count.mock.calls.every(([args]) => args.where.collection_id === null)).toBe(true);
    const archive = db.artwork.findMany.mock.calls.find(([args]) => args.include?.collection);
    expect(archive?.[0].where.collection_id).toBeNull();
    expect(archive?.[0].where.status.in).toContain("retail_stock");
  });
  it("disables allocation at zero and rejects unknown collections", async () => {
    db.artwork.count.mockResolvedValue(0);
    const response = await get("/admin/collections/okg");
    expect(response.body).toContain('type="submit" disabled>Request Retail Stock');
    expect((await get("/admin/collections/missing")).statusCode).toBe(404);
  });
});

describe("retail requests from collection details", () => {
  it("rejects forged forms and invalid quantities without writes", async () => {
    expect((await post("2", { csrf_token: "bad" })).statusCode).toBe(403);
    for (const quantity of ["0", "-1", "1.5", "NaN", "1001"]) expect((await post(quantity)).statusCode).toBe(400);
    expect(db.retailBatch.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("does not partially allocate if the current free stock is below the requested quantity", async () => {
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(selected);
    const response = await post("3");
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("No partial batch created");
    expect(db.retailBatch.create).not.toHaveBeenCalled();
    expect(db.artwork.updateMany).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("allocates once, writes a private backup before mutation, and redirects to the batch result", async () => {
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(selected);
    const response = await post("2");
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/admin/collections/okg?retail_batch=${reference}`);
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`${reference}-before-`), expect.any(String), { mode: 0o600, flag: "wx" });
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(db.retailBatch.create.mock.invocationCallOrder[0]);
    expect(db.retailBatch.create.mock.calls[0][0].data.collection_id).toBe("okg");
    expect(db.artwork.updateMany).toHaveBeenCalledTimes(2);
    expect(db.artwork.updateMany.mock.calls[0][0].data.status).toBe("retail_stock");
    db.retailBatch.findUnique.mockResolvedValue({ id: reference, collection_id: "okg", retailer: okg.artist_name, items: selected });
    expect((await post("2")).statusCode).toBe(303);
    expect(db.artwork.updateMany).toHaveBeenCalledTimes(2);
  });
  it("shows successful allocation and a Shopify inventory warning without exposing credentials", async () => {
    db.retailBatch.findUnique.mockResolvedValue({ id: reference, collection_id: "okg", _count: { items: 25 } });
    db.retailBatch.findMany.mockResolvedValue([{ id: reference, collection_id: "okg", created_at: new Date("2026-11-19T10:00:00Z"), items: selected }]);
    const response = await get(`/admin/collections/okg?retail_batch=${reference}`);
    expect(response.body).toContain(`${reference}</strong>: 25 IRIS allocated`);
    expect(response.body).toContain("Shopify inventory was not updated");
    expect(response.body).toContain(`/admin/retail/${reference}/labels.csv`);
    expect(response.body).toContain(`value="${reference}" selected`);
    const archive = db.artwork.findMany.mock.calls.find(([args]) => args.include?.collection);
    expect(archive?.[0].where.iris_id).toEqual({ in: selected.map((item) => item.iris_id) });
  });
});

describe("collection batch grouping", () => {
  const first = { id: "OKG-RETAIL-001", collection_id: "okg", created_at: new Date("2026-11-18T20:00:00Z"),
    items: Array.from({ length: 25 }, (_, i) => ({ iris_id: `OKG${String(i + 1).padStart(3, "0")}` })) };
  const second = { id: "RETAIL-20261119-AAA", collection_id: "okg", created_at: new Date("2026-11-19T20:00:00Z"),
    items: ["OKG095", "OKG042", "OKG061"].map((iris_id) => ({ iris_id })) };
  const seed = () => {
    db.retailBatch.findMany.mockResolvedValue([second, first]);
    db.artwork.findMany.mockImplementation(({ select, where }) => {
      if (select?.status) return Promise.resolve([]);
      let ids = [...first.items, ...second.items].map((item) => item.iris_id);
      if (where?.iris_id?.in) ids = ids.filter((id) => where.iris_id.in.includes(id));
      if (where?.iris_id?.notIn) ids = ids.filter((id) => !where.iris_id.notIn.includes(id));
      return Promise.resolve(ids.map(work));
    });
  };
  it("shows the newest group first with its three serials and stable batch numbers", async () => {
    seed();
    const response = await get("/admin/collections/okg");
    expect(response.statusCode).toBe(200);
    expect(response.body.indexOf(`data-batch-id="${second.id}"`)).toBeLessThan(response.body.indexOf(`data-batch-id="${first.id}"`));
    expect(response.body).toContain("<strong>Batch 2</strong>");
    expect(response.body).toContain("<strong>Batch 1</strong>");
    const rows = [...response.body.matchAll(/<td><a class="iris-link"[^>]+>([^<]+)<\/a><\/td>/g)].map((match) => match[1]);
    expect(rows.slice(0, 3)).toEqual(["OKG042", "OKG061", "OKG095"]);
    expect(response.body).toContain("3 IRIS");
    expect(response.body).toContain('/admin/retail/RETAIL-20261119-AAA/labels.csv');
  });
  it("opens a newly created batch immediately and can switch back to all batches", async () => {
    seed();
    const response = await get(`/admin/collections/okg?retail_batch=${second.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`value="${second.id}" selected`);
    expect(response.body).toContain("<strong>Batch 2</strong>");
    expect(response.body).not.toContain("<strong>Batch 1</strong>");
    const all = await get(`/admin/collections/okg?retail_batch=${second.id}&batch=`);
    expect(all.body).toContain("<strong>Batch 1</strong>");
  });
  it("preserves filters on tabs, pagination, detail arrows and back links", async () => {
    seed();
    const response = await get(`/admin/collections/okg?batch=${first.id}&q=OKG&status=unactivated`);
    expect(response.body).toContain(`status=unactivated&amp;page=2&amp;batch=${first.id}`);
    expect(response.body).toContain(`status=activated&amp;batch=${first.id}`);
    expect(response.body).toContain(`name="batch" value="${first.id}"`);
    db.artwork.findUnique.mockResolvedValue(work("OKG004"));
    const detail = await get(`/admin/iris/OKG004?collection=okg&from_collection=okg&batch=${first.id}`);
    expect(detail.body).toContain(`href="/admin/collections/okg?collection=okg&amp;batch=${first.id}">Back`);
    expect(detail.body).toContain(`from_collection=okg&amp;batch=${first.id}`);
  });
  it("does not renumber on search and rejects a batch outside this collection", async () => {
    seed();
    const response = await get(`/admin/collections/okg?batch=${second.id}&q=095`);
    expect(response.body).toContain("<strong>Batch 2</strong>");
    expect((await get("/admin/collections/okg?batch=FOREIGN-BATCH")).statusCode).toBe(400);
  });
});
