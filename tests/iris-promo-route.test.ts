import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const db = vi.hoisted(() => ({
  irisAccountSession: { findFirst: vi.fn(), update: vi.fn() },
  shopifyOrder: { findMany: vi.fn() },
  event: { findMany: vi.fn() }, artwork: { findMany: vi.fn() }, $disconnect: vi.fn()
}));
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: { releaseIntervalMinutes: 60, googleAnalyticsId: "" } }));

import { createServer } from "../src/server.js";
import { irisPromo, IrisPromoError, irisPromoCsrf } from "../src/iris-promo.js";

const redeem = vi.spyOn(irisPromo, "redeem");
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const csrf = (token: string) => irisPromoCsrf(hash(token));
const url = "/apps/iris/v3/promo/redeem";
let app: FastifyInstance;
const savePreview = async (name: string, html: string) => {
  const directory = process.env.IRIS_ACCOUNT_LAYOUT_PREVIEW_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${name}.html`), html);
};

beforeEach(async () => {
  vi.resetAllMocks();
  db.irisAccountSession.findFirst.mockImplementation(async ({ where }) => {
    const email = where.token_hash === hash("pilot") ? "info@gugoco.com" : where.token_hash === hash("other") ? "other@example.test" : null;
    return email ? { id: "session", user: { id: "user", email, username: "test", display_name: null, profile_public: false } } : null;
  });
  db.event.findMany.mockResolvedValue([]);
  db.artwork.findMany.mockResolvedValue([]);
  db.shopifyOrder.findMany.mockResolvedValue([]);
  redeem.mockResolvedValue({ code: "IRIS-TEST", percent: 10 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ price: 4000 }))));
  app = await createServer();
});
afterEach(async () => { await app.close(); vi.unstubAllGlobals(); });

describe("My Collection labels", () => {
  it("uses the shared account container with separate summary and artwork zones", async () => {
    db.artwork.findMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({
      iris_id: `IRIS-${String(i + 1).padStart(4, "0")}`, status: "activated", collection: null,
      image_url: "https://cdn.shopify.com/s/files/1/0710/5239/4589/files/P1.png?v=1769584244",
      rarity_code: i % 2 ? "Rare" : "Common", weight_grams: 0.4, activated_at: new Date("2026-11-19T12:00:00Z")
    })));
    for (const session of ["pilot", "other"]) {
      const response = await app.inject({ url: "/apps/iris/v3/account", headers: { cookie: `iris_account_session=${session}` } });
      expect(response.body).toMatch(/<main class="page">\s*<div class="wrap">\s*<section class="hero iris-library-hero">/);
      expect(response.body).toMatch(/<\/section>\s*<section class="body iris-library-body">/);
      expect(response.body).toContain('<div class="iris-library-summary">');
      expect(response.body).toContain('id="iris-v3-library-grid"');
      expect(response.body).not.toContain('<div class="wrap wrap--flush">');
      expect(response.body.match(/<li data-rarity=/g)).toHaveLength(8);
      await savePreview(`collection-${session}`, response.body);
    }
    expect(redeem).not.toHaveBeenCalled();
  });
  it("renames the signed-in collection heading, menu and browser title without changing URLs", async () => {
    const response = await app.inject({ url: "/apps/iris/v3/account", headers: { cookie: "iris_account_session=other" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<h1>My Collection</h1>");
    expect(response.body).toContain("<title>My Collection - IRIS NYC</title>");
    expect(response.body).toContain('href="/apps/iris/v3/account?session=other">My Collection</a>');
    expect(response.body).not.toContain(">My IRIS<");
  });
  it.each(["profile", "orders"])("updates the return link and menu on %s", async (section) => {
    const response = await app.inject({ url: `/apps/iris/v3/${section}`, headers: { cookie: "iris_account_session=other" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="/apps/iris/v3/account?session=other">Back to My Collection</a>');
    expect(response.body).toContain('href="/apps/iris/v3/account?session=other">My Collection</a>');
    expect(response.body).not.toContain("Back to My IRIS");
    await savePreview(section, response.body);
  });
});

describe("My IRIS promo access", () => {
  it("only embeds the button for the signed-in pilot user, in the announcements zone", async () => {
    for (const session of ["pilot", "other", "expired"]) {
      const response = await app.inject({ url: "/apps/iris/v3/account", headers: { cookie: `iris_account_session=${session}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      if (session === "pilot") {
        expect(response.body).toMatch(/<aside class="iris-library-announcements" aria-label="Discount announcements">[\s\S]+id="iris-promo-open"/);
        expect(response.body).toContain("Redeem My Discount");
        expect(response.body).toContain(csrf("pilot"));
      } else {
        expect(response.body).not.toContain('id="iris-promo-open"');
        expect(response.body).not.toContain('<aside class="iris-library-announcements"');
      }
    }
    expect(redeem).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", csrf("expired"), 401],
    ["other", csrf("other"), 404],
    ["pilot", csrf("other"), 403],
    ["pilot", "", 403]
  ])("rejects %s without contacting Shopify", async (session, csrfToken, status) => {
    const response = await app.inject({ method: "POST", url, payload: { session, csrf_token: csrfToken, email: "info@gugoco.com" } });
    expect(response.statusCode).toBe(status);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("returns only the confirmed code and percentage to the authorized user", async () => {
    const response = await app.inject({ method: "POST", url, payload: { session: "pilot", csrf_token: csrf("pilot"), percent: 90 } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ code: "IRIS-TEST", percent: 10 });
    expect(redeem).toHaveBeenCalledWith();
  });

  it("keeps a missing-scope message in a response Shopify's proxy can forward", async () => {
    redeem.mockRejectedValueOnce(new IrisPromoError("scope", "Shopify discount permissions are not enabled yet."));
    const response = await app.inject({ method: "POST", url, payload: { session: "pilot", csrf_token: csrf("pilot") } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ message: "Shopify discount permissions are not enabled yet.", retryable: false });
  });

  it("accepts a valid body session even if an unrelated browser cookie is malformed", async () => {
    const response = await app.inject({ method: "POST", url, headers: { cookie: "unrelated=%ZZ" }, payload: { session: "pilot", csrf_token: csrf("pilot") } });
    expect(response.statusCode).toBe(200);
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it("preserves a retryable failure without returning internal error details", async () => {
    redeem.mockRejectedValueOnce(new Error("upstream private detail"));
    const response = await app.inject({ method: "POST", url, payload: { session: "pilot", csrf_token: csrf("pilot") } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ message: "My IRIS could not finish the discount request. Please try again.", retryable: true });
  });
});
