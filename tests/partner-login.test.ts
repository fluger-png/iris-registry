import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { collaboratorProfileCsrf } from "../src/collaborator-profile.js";
import { collectionCsrf } from "../src/partner-collections.js";
import { collectionPricing, CollectionPriceError, priceRevision, ReadyPrice } from "../src/shopify-product-pricing.js";

const db = vi.hoisted(() => ({
  collaboratorUser: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  collaboratorCollectionAccess: { findMany: vi.fn() },
  collaboratorProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  collectionPresentation: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  collaboratorSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  collaboratorInvite: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  collection: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  artwork: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(), $disconnect: vi.fn()
}));

vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: {
  adminBasicUser: "test-admin", adminBasicPass: "test-password", adminTimezone: "America/New_York",
  baseUrl: "https://partner.test", partnerPortalBaseUrl: "https://partner.test",
  partnerInviteTtlHours: 24, partnerSessionTtlDays: 30, releaseIntervalMinutes: 60,
  r2AccountId: "test", r2AccessKeyId: "test", r2SecretAccessKey: "test",
  r2Bucket: "test", r2PublicBaseUrl: "https://images.example.test",
  resendApiKey: "", resendFromEmail: ""
} }));

import { createServer } from "../src/server.js";

const ararat = { id: "ararat", slug: "ararat-heart", name: "Ararat Heart", edition_size: 100, status: "active" };
const sayat = { id: "sayat", slug: "sayat-nova", name: "Sayat Nova", edition_size: 100, status: "active" };
const salt = Buffer.from("partner-test-salt");
const password = "collection-password";
const passwordHash = `${salt.toString("hex")}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
const user = { id: "gugoco", email: "partner@example.test", full_name: "Gugoco", status: "active", password_hash: passwordHash, collection: null };
const auth = { authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` };
const form = { "content-type": "application/x-www-form-urlencoded" };
const partnerCookie = { cookie: "iris_partner_session=test" };
const sessionHash = "test-session-hash";
const upload = vi.spyOn(S3Client.prototype, "send");
const inspectPrice = vi.spyOn(collectionPricing, "inspect");
const readPrice = vi.spyOn(collectionPricing, "read");
const updatePrice = vi.spyOn(collectionPricing, "update");
const readyPrice: ReadyPrice = { ready: true, productId: "gid://shopify/Product/100", variantId: "gid://shopify/ProductVariant/200", handle: "ararat-heart", priceCents: 12000, currency: "USD", updatedAt: "2026-10-26T20:00:00Z" };
let app: FastifyInstance;

beforeEach(async () => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((fn) => fn(db));
  db.$queryRaw.mockResolvedValue([{ locked: true }]);
  inspectPrice.mockResolvedValue({ ready: false, message: "Shopify pricing is temporarily unavailable." });
  readPrice.mockResolvedValue(readyPrice);
  updatePrice.mockResolvedValue({ ...readyPrice, priceCents: 13000 });
  db.collection.findMany.mockResolvedValue([ararat, sayat]);
  db.collaboratorCollectionAccess.findMany.mockResolvedValue([{ collection: ararat }, { collection: sayat }]);
  db.collaboratorUser.findUnique.mockResolvedValue(user);
  db.collaboratorUser.create.mockResolvedValue({ ...user, status: "invited" });
  db.collaboratorSession.findFirst.mockResolvedValue({ id: "session", token_hash: sessionHash, user });
  db.collaboratorProfile.findUnique.mockResolvedValue(null);
  db.collectionPresentation.findUnique.mockResolvedValue(null);
  db.collectionPresentation.updateMany.mockResolvedValue({ count: 1 });
  db.artwork.findMany.mockResolvedValue([]);
  db.artwork.count.mockResolvedValue(6);
  db.artwork.aggregate.mockResolvedValue({ _avg: { weight_grams: 0.41 } });
  upload.mockResolvedValue({} as never);
  db.collaboratorInvite.findFirst.mockResolvedValue({
    id: "invite", accepted_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000),
    user: { ...user, status: "invited" }
  });
  db.collaboratorInvite.updateMany.mockResolvedValue({ count: 1 });
  db.artwork.groupBy.mockResolvedValue([
    { collection_id: "ararat", _count: { _all: 3 } },
    { collection_id: "sayat", _count: { _all: 4 } }
  ]);
  app = await createServer();
});

const boundary = "partner-profile-test-boundary";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=", "base64");
const profilePayload = (fields: Record<string, string>, file?: { data: Buffer; name: string; type: string }) => {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from("\r\n"));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
};
const profileHeaders = { ...partnerCookie, "content-type": `multipart/form-data; boundary=${boundary}` };
const validProfileFields = { csrf_token: collaboratorProfileCsrf(sessionHash), description: "Art by Gugoco" };

const collectionFields = { csrf_token: collectionCsrf(sessionHash, "ararat"), revision: "-1", display_name: "Ararat Heart", visible: "1", description: "The collection story." };
const collectionPayload = (fields = collectionFields, files: Array<{ field: string; data: Buffer; name?: string }> = []) => Buffer.concat([
  ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
  ...files.flatMap((file) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name ?? "image.png"}"\r\nContent-Type: image/png\r\n\r\n`), file.data, Buffer.from("\r\n")]),
  Buffer.from(`--${boundary}--\r\n`)
]);

describe("partner Shopify price editor", () => {
  const priceFields = () => ({ csrf_token: collectionCsrf(sessionHash, "ararat"), price_revision: priceRevision(sessionHash, "ararat", readyPrice), price: "130" });
  const submit = (fields = priceFields(), id = "ararat") => app.inject({ method: "POST", url: `/partner/collections/${id}/price`, headers: { ...partnerCookie, ...form }, payload: new URLSearchParams(fields).toString() });

  it("renders a separate price form with an authoritative price and no trailing zeros", async () => {
    inspectPrice.mockResolvedValue(readyPrice);
    const response = await app.inject({ method: "GET", url: "/partner/collections/ararat", headers: partnerCookie });
    expect(response.body).toContain('form="collection-price-form" type="text" inputmode="decimal" maxlength="9" value="120"');
    expect(response.body).toContain('action="/partner/collections/ararat/price"');
    expect(response.body).toContain(`value="${priceRevision(sessionHash, "ararat", readyPrice)}"`);
    expect(response.body).toContain('form="collection-price-form">Save price</button>');
    if (process.env.IRIS_PARTNER_PREVIEW_DIR) {
      await fs.mkdir(process.env.IRIS_PARTNER_PREVIEW_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.IRIS_PARTNER_PREVIEW_DIR, "price-editor.html"), response.body);
    }
  });

  it("requires a partner session and collection access before reading prices", async () => {
    expect((await app.inject({ method: "POST", url: "/partner/collections/ararat/price", headers: form, payload: "price=130" })).statusCode).toBe(302);
    expect((await submit(priceFields(), "unseen")).statusCode).toBe(404);
    expect(readPrice).not.toHaveBeenCalled();
    expect(updatePrice).not.toHaveBeenCalled();
  });

  it("rejects invalid CSRF, forged product IDs, duplicate values and invalid prices", async () => {
    expect((await submit({ ...priceFields(), csrf_token: collectionCsrf(sessionHash, "sayat") })).statusCode).toBe(403);
    expect((await submit({ ...priceFields(), product_id: "other" } as ReturnType<typeof priceFields>)).statusCode).toBe(400);
    for (const price of ["0", "-1", "120.001", "1e3", "", "1000000"]) expect((await submit({ ...priceFields(), price })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/partner/collections/ararat/price", headers: { ...partnerCookie, ...form }, payload: `${new URLSearchParams(priceFields())}&price=1` })).statusCode).toBe(400);
    expect(updatePrice).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and busy locks without writing to Shopify", async () => {
    readPrice.mockResolvedValue({ ...readyPrice, priceCents: 12500 });
    expect((await submit()).statusCode).toBe(409);
    readPrice.mockResolvedValue(readyPrice);
    db.$queryRaw.mockResolvedValue([{ locked: false }]);
    expect((await submit()).statusCode).toBe(409);
    expect(updatePrice).not.toHaveBeenCalled();
  });

  it("saves only the authorized price and redirects after Shopify confirmation", async () => {
    const response = await submit();
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/partner/collections/ararat?price_saved=1");
    expect(updatePrice).toHaveBeenCalledTimes(1);
    expect(updatePrice).toHaveBeenCalledWith(ararat, readyPrice, 13000);
    expect(db.collectionPresentation.create).not.toHaveBeenCalled();
    expect(db.collectionPresentation.updateMany).not.toHaveBeenCalled();
    expect(db.collection.create).not.toHaveBeenCalled();
  });

  it("shows uncertain outcomes without a success redirect", async () => {
    updatePrice.mockRejectedValue(new CollectionPriceError("unconfirmed", "Reload to check the current price."));
    const response = await submit();
    expect(response.statusCode).toBe(503);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain("Reload to check the current price.");
    expect(response.body).not.toContain("Price saved in Shopify.");
  });

  it("does not call Shopify writes when saving collection presentation", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload() });
    expect(response.statusCode).toBe(303);
    expect(updatePrice).not.toHaveBeenCalled();
  });
});

describe("partner collection editor", () => {
  it("uses live storefront prices instead of stale collection defaults", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([{ collection: { ...ararat, shopify_handle: "ararat-test", default_price_cents: 99900 } }, { collection: { ...sayat, shopify_handle: "sayat-test" } }]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ price: url.includes("ararat") ? 12000 : 16000, featured_image: `https://cdn.shopify.com/s/files/1/0710/5239/4589/files/${url.includes("ararat") ? "ararat.png?v=1777477903" : "sayat.png?v=1777277215"}` }))));
    db.artwork.findMany.mockResolvedValue([{ status: "assigned", weight_grams: 0.4 }, { status: "activated", weight_grams: 0.42 }]);
    const dashboard = await app.inject({ method: "GET", url: "/partner", headers: partnerCookie });
    const detail = await app.inject({ method: "GET", url: "/partner/collections/ararat", headers: partnerCookie });
    expect(dashboard.body).toContain("<dd>$120</dd>");
    expect(dashboard.body).toContain("<dd>$160</dd>");
    expect(dashboard.body).not.toContain("$999");
    expect(detail.body).toContain('value="$120" disabled');
    if (process.env.IRIS_PARTNER_PREVIEW_DIR) {
      await fs.mkdir(process.env.IRIS_PARTNER_PREVIEW_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.IRIS_PARTNER_PREVIEW_DIR, "collections.html"), dashboard.body);
      await fs.writeFile(path.join(process.env.IRIS_PARTNER_PREVIEW_DIR, "collection.html"), detail.body);
    }
  });

  it("preserves cents when the collection price is not a whole amount", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([{ collection: { ...ararat, shopify_handle: "ararat-with-cents-test" } }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ price: 12050 }))));
    const dashboard = await app.inject({ method: "GET", url: "/partner", headers: partnerCookie });
    const detail = await app.inject({ method: "GET", url: "/partner/collections/ararat", headers: partnerCookie });
    expect(dashboard.body).toContain("<dd>$120.50</dd>");
    expect(detail.body).toContain('value="$120.50" disabled');
  });

  it("renders linked two-column cards with 16:9 banners and purchased statistics", async () => {
    db.artwork.findMany.mockResolvedValue([{ status: "assigned", weight_grams: 0.4 }, { status: "activated", weight_grams: 0.6 }, { status: "activated", weight_grams: null }]);
    const response = await app.inject({ method: "GET", url: "/partner", headers: partnerCookie });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="/partner/collections/ararat"');
    expect(response.body).toContain("aspect-ratio:16/9");
    expect(response.body).toContain("<dt>Purchased</dt><dd>3</dd>");
    expect(response.body).toContain("<dt>Activated</dt><dd>2</dd>");
    const detail = await app.inject({ method: "GET", url: "/partner/collections/ararat", headers: partnerCookie });
    expect(detail.body).toContain("0.500 g");
    expect(detail.body).toContain("Gold weight recorded for 2 of 3");
    expect(detail.body).toContain('id="collection-price" value="Unavailable" disabled');
    expect(detail.body).toContain('name="image_3"');
    expect(detail.body).not.toContain('name="image_4"');
  });

  it("requires login on both collection routes", async () => {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({ method, url: "/partner/collections/ararat" });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/partner/login");
    }
  });

  it("rejects ungranted collections before loading or changing their data", async () => {
    for (const method of ["GET", "POST"] as const) {
      expect((await app.inject({ method, url: "/partner/collections/unseen", headers: partnerCookie })).statusCode).toBe(404);
    }
    expect(db.collectionPresentation.findUnique).not.toHaveBeenCalled();
    expect(db.artwork.findMany).not.toHaveBeenCalled();
    expect(db.collectionPresentation.create).not.toHaveBeenCalled();
  });

  it("saves presentation without changing canonical collection identity or inventory", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders,
      payload: collectionPayload({ ...collectionFields, display_name: "Ararat <New>" }) });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/partner/collections/ararat?saved=1");
    expect(db.collectionPresentation.create).toHaveBeenCalledWith({ data: {
      collection_id: "ararat", display_name: "Ararat <New>", description: "The collection story.", visible: true, banner_url: null, gallery_urls: ["", "", "", ""]
    } });
    expect(db.collection.create).not.toHaveBeenCalled();
  });

  it("requires CSRF bound to both the session and the selected collection", async () => {
    for (const csrf_token of ["bad", collectionCsrf("another-session", "ararat"), collectionCsrf(sessionHash, "sayat")]) {
      const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload({ ...collectionFields, csrf_token }, [{ field: "banner", data: png }]) });
      expect(response.statusCode).toBe(403);
    }
    expect(upload).not.toHaveBeenCalled();
    expect(db.collectionPresentation.create).not.toHaveBeenCalled();
  });

  it("uploads a banner and four images to the authorized collection only", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders,
      payload: collectionPayload(collectionFields, ["banner", "image_0", "image_1", "image_2", "image_3"].map((field) => ({ field, data: png }))) });
    expect(response.statusCode).toBe(303);
    expect(upload).toHaveBeenCalledTimes(5);
    for (const [command] of upload.mock.calls) expect((command as { input: { Key: string } }).input.Key).toMatch(/^collections\/ararat\/[a-f0-9-]+\.png$/);
    expect(db.collectionPresentation.create.mock.calls[0][0].data.gallery_urls).toHaveLength(4);
  });

  it("rejects unexpected editable fields, a fifth preview, duplicate files, and SVGs", async () => {
    for (const payload of [
      collectionPayload({ ...collectionFields, price_cents: "1" } as typeof collectionFields),
      collectionPayload({ ...collectionFields, collection_id: "sayat" } as typeof collectionFields),
      collectionPayload(collectionFields, [{ field: "image_4", data: png }]),
      collectionPayload(collectionFields, [{ field: "banner", data: png }, { field: "banner", data: png }]),
      collectionPayload(collectionFields, [{ field: "banner", data: Buffer.from('<svg onload="alert(1)"></svg>') }]),
      collectionPayload(collectionFields, [{ field: "banner", data: Buffer.alloc(2 * 1024 * 1024 + 1) }])
    ]) {
      expect((await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload })).statusCode).toBe(400);
    }
    expect(upload).not.toHaveBeenCalled();
    expect(db.collectionPresentation.create).not.toHaveBeenCalled();
  });

  it("preserves empty file inputs and removes only requested images", async () => {
    db.collectionPresentation.findUnique.mockResolvedValue({ revision: 2, display_name: "Name", banner_url: "https://images.test/banner.png", gallery_urls: ["a", "b", "c", "d"], visible: true, description: "old" });
    const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders,
      payload: collectionPayload({ ...collectionFields, revision: "2", remove_image_1: "1", remove_banner: "1" } as typeof collectionFields, [{ field: "image_0", data: Buffer.alloc(0), name: "" }]) });
    expect(response.statusCode).toBe(303);
    expect(db.collectionPresentation.updateMany.mock.calls[0][0].data).toMatchObject({ banner_url: null, gallery_urls: ["a", "", "c", "d"], revision: { increment: 1 } });
    expect(upload).not.toHaveBeenCalled();
  });

  it("hides only the storefront presentation when the toggle is off", async () => {
    const { visible, ...fields } = collectionFields;
    const response = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload(fields as typeof collectionFields) });
    expect(response.statusCode).toBe(303);
    expect(db.collectionPresentation.create.mock.calls[0][0].data.visible).toBe(false);
    expect(db.collectionPresentation.create.mock.calls[0][0].data).not.toHaveProperty("status");
  });

  it("rejects stale revisions before upload, and conflicting updates at write time", async () => {
    db.collectionPresentation.findUnique.mockResolvedValue({ revision: 2, gallery_urls: [] });
    const stale = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload(collectionFields, [{ field: "banner", data: png }]) });
    expect(stale.statusCode).toBe(409);
    expect(upload).not.toHaveBeenCalled();
    db.collectionPresentation.updateMany.mockResolvedValue({ count: 0 });
    const conflict = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload({ ...collectionFields, revision: "2" }) });
    expect(conflict.statusCode).toBe(409);
  });

  it("keeps the dashboard available but prevents saves before migration", async () => {
    db.collectionPresentation.findUnique.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "5.22.0" }));
    expect((await app.inject({ method: "GET", url: "/partner", headers: partnerCookie })).statusCode).toBe(200);
    const save = await app.inject({ method: "POST", url: "/partner/collections/ararat", headers: profileHeaders, payload: collectionPayload() });
    expect(save.statusCode).toBe(503);
    expect(db.collectionPresentation.create).not.toHaveBeenCalled();
  });

  it("publishes presentation and sales aggregates, without owner emails, orders or individual artwork details", async () => {
    db.collection.findFirst.mockResolvedValue(ararat);
    db.collectionPresentation.findUnique.mockResolvedValue({ display_name: "Ararat", banner_url: "https://images.test/banner.png", description: "Story", gallery_urls: ["", "https://images.test/one.png"], visible: false, revision: 5 });
    const response = await app.inject({ method: "GET", url: "/apps/iris/collection-presentation?handle=ararat-heart" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ display_name: "Ararat", banner_url: "https://images.test/banner.png", description: "Story", images: ["https://images.test/one.png"], visible: false, edition_size: 100, sold_count: 6, average_sold_weight_grams: 0.41 });
    expect(db.artwork.count).toHaveBeenCalledWith({ where: { collection_id: "ararat", assigned_order_id: { not: null }, status: { in: ["assigned", "activated"] } } });
    expect(db.artwork.aggregate).toHaveBeenCalledWith({ where: { collection_id: "ararat", assigned_order_id: { not: null }, status: { in: ["assigned", "activated"] }, weight_grams: { gt: 0 } }, _avg: { weight_grams: true } });
    expect(db.artwork.findMany).not.toHaveBeenCalled();
  });

  it("counts only core sales for each legacy core collection alias", async () => {
    db.artwork.count.mockResolvedValue(150);
    for (const handle of ["iris-the-unseen-edition", "iris-collection", "iris"]) {
      const response = await app.inject({ method: "GET", url: `/apps/iris/collection-presentation?handle=${handle}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ visible: true, edition_size: 10000, sold_count: 150 });
    }
    expect(db.artwork.count).toHaveBeenCalledWith({ where: { collection_id: null, assigned_order_id: { not: null }, status: { in: ["assigned", "activated"] } } });
    expect(db.artwork.aggregate).toHaveBeenCalledWith({ where: { collection_id: null, assigned_order_id: { not: null }, status: { in: ["assigned", "activated"] }, weight_grams: { gt: 0 } }, _avg: { weight_grams: true } });
    expect(db.collection.findFirst).not.toHaveBeenCalled();
    expect(db.artwork.findMany).not.toHaveBeenCalled();
  });

  it("returns zero sales honestly and never counts all artwork for an unknown collection", async () => {
    db.collection.findFirst.mockResolvedValue(sayat);
    db.artwork.count.mockResolvedValue(0);
    const response = await app.inject({ method: "GET", url: "/apps/iris/collection-presentation?handle=sayat-nova" });
    expect(response.json()).toMatchObject({ edition_size: 100, sold_count: 0 });
    expect(db.artwork.count).toHaveBeenCalledWith({ where: { collection_id: "sayat", assigned_order_id: { not: null }, status: { in: ["assigned", "activated"] } } });
    db.artwork.count.mockClear();
    db.artwork.aggregate.mockClear();
    db.collection.findFirst.mockResolvedValue(null);
    expect((await app.inject({ method: "GET", url: "/apps/iris/collection-presentation?handle=unknown" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/apps/iris/collection-presentation?handle=invalid!" })).statusCode).toBe(400);
    expect(db.artwork.count).not.toHaveBeenCalled();
    expect(db.artwork.aggregate).not.toHaveBeenCalled();
  });

  it("returns no average when sold weights are missing or invalid, without changing the sold count", async () => {
    db.collection.findFirst.mockResolvedValue(sayat);
    for (const weight of [null, 0, -1, NaN, Infinity]) {
      db.artwork.aggregate.mockResolvedValue({ _avg: { weight_grams: weight } });
      const response = await app.inject({ method: "GET", url: "/apps/iris/collection-presentation?handle=sayat-nova" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sold_count: 6, average_sold_weight_grams: null });
    }
  });
});

describe("partner workspace", () => {
  it("uses the IRIS account typography and palette on partner pages", async () => {
    for (const url of ["/partner/login", "/partner", "/partner/profile"]) {
      const response = await app.inject({ method: "GET", url, headers: url === "/partner/login" ? {} : partnerCookie });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("family=Abel&family=Unbounded:wght@400;500;600;700");
      expect(response.body).toContain('--font-body:"Abel"');
      expect(response.body).toContain('--font-heading:"Unbounded"');
      expect(response.body).toContain("--gold-bright:#eabf50");
      expect(response.body).toContain("--text:#ede8df");
      expect(response.body).toContain("font-size:14px;");
      expect(response.body).toContain("font-weight:700;");
    }
  });

  it("blocks anonymous visits and profile changes", async () => {
    for (const url of ["/partner/irises", "/partner/profile"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/partner/login");
    }
    const response = await app.inject({ method: "POST", url: "/partner/profile", payload: "" });
    expect(response.statusCode).toBe(302);
    expect(db.artwork.findMany).not.toHaveBeenCalled();
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });

  it("lists only granted activated works with safe fields and a stable order", async () => {
    db.artwork.count.mockResolvedValue(1);
    db.artwork.findMany.mockResolvedValue([{
      iris_id: "AR-0048", collection: ararat, image_url: "https://images.example.test/ar48.png",
      owner_email: "owner@example.test", activated_at: new Date("2026-10-20T12:00:00Z"), assigned_order_id: "#1035"
    }]);
    const response = await app.inject({ method: "GET", url: "/partner/irises?user_id=someone-else", headers: partnerCookie });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain("AR-048");
    expect(response.body).toContain("owner@example.test");
    expect(response.body).toContain("#1035");
    expect(response.body).toContain("10.20.26");
    const query = db.artwork.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ collection_id: { in: ["ararat", "sayat"] }, status: "activated" });
    expect(query.orderBy).toEqual([{ activated_at: "desc" }, { iris_id: "asc" }]);
    expect(query.select).not.toHaveProperty("pin_code");
    expect(query.select).not.toHaveProperty("activation_token");
    expect(query.select).not.toHaveProperty("assigned_customer_email");
  });

  it("rejects a forged collection filter before reading artworks", async () => {
    const response = await app.inject({ method: "GET", url: "/partner/irises?collection=unseen", headers: partnerCookie });
    expect(response.statusCode).toBe(404);
    expect(db.artwork.count).not.toHaveBeenCalled();
  });

  it("applies filters inside the permitted collection scope and clamps pagination", async () => {
    db.artwork.count.mockResolvedValue(51);
    db.artwork.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/partner/irises?collection=ararat&q=owner&page=999", headers: partnerCookie });
    expect(response.statusCode).toBe(200);
    const query = db.artwork.findMany.mock.calls[0][0];
    expect(query.where.collection_id).toEqual({ in: ["ararat"] });
    expect(query.where.status).toBe("activated");
    expect(query.where.OR).toContainEqual({ owner_email: { contains: "owner", mode: "insensitive" } });
    expect(query.skip).toBe(50);
    expect(query.take).toBe(50);
  });

  it("does not read core inventory for an empty scope", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/partner/irises", headers: partnerCookie });
    expect(response.body).toContain("No activated IRIS found");
    expect(db.artwork.count).not.toHaveBeenCalled();
    expect(db.artwork.findMany).not.toHaveBeenCalled();
  });

  it("finds older four-digit stored IDs using the displayed three-digit serial", async () => {
    db.artwork.count.mockResolvedValue(0);
    await app.inject({ method: "GET", url: "/partner/irises?q=AR-048", headers: partnerCookie });
    expect(db.artwork.count.mock.calls[0][0].where.OR).toContainEqual({ iris_id: { equals: "AR-0048", mode: "insensitive" } });
  });

  it("keeps collection creation disabled and omits brand description from collections", async () => {
    db.collaboratorProfile.findUnique.mockResolvedValue({ description: '<script>alert("bad")</script>', avatar_url: null });
    const response = await app.inject({ method: "GET", url: "/partner", headers: partnerCookie });
    expect(response.body).toContain('disabled title="Coming soon"');
    expect(response.body).not.toContain("&lt;script&gt;");
    expect(response.body).not.toContain('<script>alert("bad")</script>');
  });

  it("keeps existing pages usable while the profile table is missing", async () => {
    db.collaboratorProfile.findUnique.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing table", { code: "P2021", clientVersion: "5.22.0" }));
    const response = await app.inject({ method: "GET", url: "/partner", headers: partnerCookie });
    expect(response.statusCode).toBe(200);
    const profile = await app.inject({ method: "GET", url: "/partner/profile", headers: partnerCookie });
    expect(profile.body).toContain("temporarily unavailable");
    const save = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders, payload: profilePayload(validProfileFields) });
    expect(save.statusCode).toBe(503);
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });

  it("saves only the signed-in brand, ignoring forged user and collection IDs", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile?user_id=other", headers: profileHeaders,
      payload: profilePayload({ ...validProfileFields, user_id: "other", collection_id: "unseen", avatar_url: "https://evil.test/x" }) });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/partner/profile?saved=1");
    expect(db.collaboratorProfile.upsert).toHaveBeenCalledWith({
      where: { user_id: "gugoco" }, create: { user_id: "gugoco", description: "Art by Gugoco", avatar_url: null }, update: { description: "Art by Gugoco" }
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects invalid and other-session CSRF tokens before uploads or writes", async () => {
    for (const csrf_token of ["", "bad", collaboratorProfileCsrf("another-session")]) {
      const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
        payload: profilePayload({ ...validProfileFields, csrf_token }, { data: png, name: "avatar.png", type: "image/png" }) });
      expect(response.statusCode).toBe(403);
    }
    expect(upload).not.toHaveBeenCalled();
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });

  it("stores raster avatars under the signed-in user's namespace", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload(validProfileFields, { data: png, name: "../../other.svg", type: "image/svg+xml" }) });
    expect(response.statusCode).toBe(303);
    const input = (upload.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.Key).toMatch(/^partners\/gugoco\/[a-f0-9-]+\.png$/);
    expect(input.ContentType).toBe("image/png");
    expect(db.collaboratorProfile.upsert.mock.calls[0][0].update.avatar_url).toMatch(/^https:\/\/images.example.test\/partners\/gugoco\//);
  });

  it("rejects SVG disguised as a PNG", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload(validProfileFields, { data: Buffer.from('<svg onload="alert(1)"></svg>'), name: "avatar.png", type: "image/png" }) });
    expect(response.statusCode).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads and descriptions without writing", async () => {
    const largeImage = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload(validProfileFields, { data: Buffer.alloc(2 * 1024 * 1024 + 1), name: "big.png", type: "image/png" }) });
    expect(largeImage.statusCode).toBe(400);
    const largeText = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload({ ...validProfileFields, description: "a".repeat(2001) }) });
    expect(largeText.statusCode).toBe(400);
    expect(upload).not.toHaveBeenCalled();
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });

  it("removes the avatar reference without deleting stored images", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload({ ...validProfileFields, remove_avatar: "1" }) });
    expect(response.statusCode).toBe(303);
    expect(db.collaboratorProfile.upsert.mock.calls[0][0].update.avatar_url).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not clear an avatar when the browser submits an empty file field", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload(validProfileFields, { data: Buffer.alloc(0), name: "", type: "application/octet-stream" }) });
    expect(response.statusCode).toBe(303);
    expect(db.collaboratorProfile.upsert.mock.calls[0][0].update).toEqual({ description: "Art by Gugoco" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not clear the description when the form field is missing", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload({ csrf_token: validProfileFields.csrf_token }) });
    expect(response.statusCode).toBe(400);
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });

  it("leaves the previous profile unchanged on an upload failure", async () => {
    upload.mockRejectedValue(new Error("Storage unavailable") as never);
    const response = await app.inject({ method: "POST", url: "/partner/profile", headers: profileHeaders,
      payload: profilePayload(validProfileFields, { data: png, name: "avatar.png", type: "image/png" }) });
    expect(response.statusCode).toBe(503);
    expect(db.collaboratorProfile.upsert).not.toHaveBeenCalled();
  });
});

afterEach(async () => { await app.close(); vi.unstubAllGlobals(); });

describe("partner access routes", () => {
  it("redirects an anonymous visitor without reading inventory", async () => {
    const response = await app.inject({ method: "GET", url: "/partner" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/partner/login");
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("creates one user with two explicit grants, no new collection or artwork", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Gugoco&email=PARTNER%40example.test&collection_ids=ararat&collection_ids=sayat" });
    expect(response.statusCode).toBe(200);
    expect(db.collection.create).not.toHaveBeenCalled();
    expect(db.collaboratorUser.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      email: "partner@example.test", collection_id: null,
      collection_access: { create: [{ collection_id: "ararat" }, { collection_id: "sayat" }] }
    }) });
    expect(db.collaboratorInvite.create).toHaveBeenCalledTimes(1);
    expect(db.collaboratorSession.deleteMany).toHaveBeenCalledWith({ where: { user_id: "gugoco" } });
    expect(response.body).toContain("Ararat Heart, Sayat Nova");
  });

  it("rejects granting an unknown collection", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Gugoco&email=partner%40example.test&collection_ids=unseen" });
    expect(response.statusCode).toBe(400);
    expect(db.collaboratorUser.create).not.toHaveBeenCalled();
  });

  it("keeps the existing single draft collection creation flow", async () => {
    db.collection.create.mockResolvedValue(ararat);
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Artist&email=artist%40example.test&collection_name=Ararat&edition_size=100" });
    expect(response.statusCode).toBe(200);
    expect(db.collection.create).toHaveBeenCalledTimes(1);
    const data = db.collaboratorUser.create.mock.calls[0][0].data;
    expect(data.collection_id).toBe("ararat");
    expect(data.collection_access).toBeUndefined();
  });

  it("does not allow partner cookies to grant admin privileges", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...form, cookie: "iris_partner_session=test" }, payload: "full_name=Bad" });
    expect(response.statusCode).toBe(401);
    expect(db.collaboratorUser.create).not.toHaveBeenCalled();
  });

  it("logs in a multi-collection account with no legacy primary collection", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: `email=PARTNER%40example.test&password=${password}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/partner");
    expect(response.headers["set-cookie"]).toEqual(expect.stringContaining("HttpOnly"));
    expect(response.headers["set-cookie"]).toEqual(expect.stringContaining("Secure"));
    expect(db.collaboratorSession.create).toHaveBeenCalledTimes(1);
  });

  it("rejects incorrect passwords and disabled accounts", async () => {
    const bad = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: "email=partner%40example.test&password=wrong" });
    expect(bad.statusCode).toBe(401);
    db.collaboratorUser.findUnique.mockResolvedValue({ ...user, status: "disabled" });
    const disabled = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: `email=partner%40example.test&password=${password}` });
    expect(disabled.statusCode).toBe(401);
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("scopes dashboard counts to Gugoco despite a forged collection query", async () => {
    const response = await app.inject({ method: "GET", url: "/partner?collection=unseen&user_id=other", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Ararat Heart");
    expect(response.body).toContain("Sayat Nova");
    expect(response.body).not.toContain("The Unseen Edition");
    expect(db.artwork.findMany).toHaveBeenCalledTimes(2);
    expect(db.artwork.findMany.mock.calls.map(([q]) => q.where.collection_id)).toEqual(["ararat", "sayat"]);
    expect(db.artwork.findMany.mock.calls[0][0].where.status).toEqual({ in: ["assigned", "activated"] });
  });

  it("never reads all inventory when grants are empty", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/partner", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("No collections assigned");
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("does not issue a session to an account with no collection permissions", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "POST", url: "/partner/login", headers: form,
      payload: `email=partner%40example.test&password=${password}` });
    expect(response.statusCode).toBe(401);
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a disabled account's existing session", async () => {
    db.collaboratorSession.findFirst.mockResolvedValue({ id: "session", user: { ...user, status: "disabled" } });
    const response = await app.inject({ method: "GET", url: "/partner", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(302);
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("shows both collections on the single invitation", async () => {
    const response = await app.inject({ method: "GET", url: "/partner/invite/test-token" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Ararat Heart, Sayat Nova");
  });

  it("accepts an invitation once and removes old sessions", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(302);
    expect(db.collaboratorInvite.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      id: "invite", accepted_at: null, revoked_at: null, user: { status: "invited" }
    }), data: expect.any(Object) });
    expect(db.collaboratorSession.deleteMany).toHaveBeenCalledWith({ where: { user_id: "gugoco" } });
  });

  it("rejects an invitation lost to a concurrent acceptance", async () => {
    db.collaboratorInvite.updateMany.mockResolvedValue({ count: 0 });
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("rejects expired invitations without changing users", async () => {
    db.collaboratorInvite.findFirst.mockResolvedValue({ id: "expired", user: { ...user, status: "invited" }, expires_at: new Date(0) });
    const response = await app.inject({ method: "POST", url: "/partner/invite/expired", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
  });

  it("does not reactivate a disabled user via an old invitation", async () => {
    db.collaboratorInvite.findFirst.mockResolvedValue({ id: "invite", accepted_at: null,
      expires_at: new Date(Date.now() + 60_000), user: { ...user, status: "disabled" } });
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
  });
});
