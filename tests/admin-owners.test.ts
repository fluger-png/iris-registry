import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const db = vi.hoisted(() => ({
  artwork: { findMany: vi.fn() },
  irisUser: { findMany: vi.fn(), findFirst: vi.fn() },
  shopifyOrder: { findMany: vi.fn() },
  event: { findMany: vi.fn() },
  ownershipTransfer: { findMany: vi.fn() },
  $disconnect: vi.fn()
}));

vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: { adminBasicUser: "test-admin", adminBasicPass: "test-password", releaseIntervalMinutes: 60 } }));

import { createServer } from "../src/server.js";

const auth = { authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` };
const alice = "alice%collector@example.test";
const bob = "bob@example.test";
const cara = "cara@example.test";
const artwork = (id: string, owner: string | null, purchaser: string | null = null, status = "activated") => ({
  iris_id: id, status, owner_email: owner, assigned_customer_email: purchaser,
  collection: id.startsWith("AR-") ? { slug: "ararat-heart", edition_size: 100 } : null,
  assigned_order_id: null, image_url: null, rarity_code: null, activated_at: null
});
const owned = [
  artwork("IRIS-1501", alice.toUpperCase(), bob),
  artwork("IRIS-1502", alice),
  artwork("AR-7", null, bob),
  artwork("IRIS-1503", cara, alice),
  artwork("IRIS-1504", null, "not-activated@example.test", "assigned"),
  artwork("IRIS-1505", null)
];
let app: FastifyInstance;

beforeEach(async () => {
  vi.resetAllMocks();
  db.artwork.findMany.mockResolvedValue(owned);
  db.irisUser.findMany.mockResolvedValue([{ email: alice, display_name: "Alice <Collector>", username: "irisalice" }]);
  db.irisUser.findFirst.mockResolvedValue({ display_name: "Alice <Collector>" });
  db.shopifyOrder.findMany.mockResolvedValue([
    { email: bob.toUpperCase(), raw_json: { customer: {} } },
    { email: bob, raw_json: { shipping_address: { first_name: "Robert", last_name: "M\u00fcller" } } }
  ]);
  db.event.findMany.mockResolvedValue([]);
  db.ownershipTransfer.findMany.mockResolvedValue([]);
  app = await createServer();
});
afterEach(async () => { await app.close(); });

const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
const getRows = (html: string) => Array.from(html.matchAll(/<tr><td><a class="customer-link"[^>]*>([^<]+)<\/a>.*?<td><strong>([\d,]+)<\/strong><\/td>/g), ([, name, count]) => [name, count]);

describe("IRIS Owners", () => {
  it("requires global admin credentials before reading owners", async () => {
    const anonymous = await app.inject("/admin/owners");
    const partner = await app.inject({ url: "/admin/owners", headers: { cookie: "iris_partner_session=test" } });
    expect(anonymous.statusCode).toBe(401);
    expect(partner.statusCode).toBe(401);
    expect(db.artwork.findMany).not.toHaveBeenCalled();
  });

  it("counts current activated holdings, not past purchases or unactivated assignments", async () => {
    const response = await get("/admin/owners");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain('<a class="active" href="/admin/owners">IRIS Owners</a>');
    expect(response.body).toContain("Total Owners</span><strong>3</strong>");
    expect(response.body).toContain("IRIS Held</span><strong>4</strong>");
    expect(response.body).toContain("Multi-IRIS Owners</span><strong>1</strong>");
    expect(response.body).toContain("Avg. per Owner</span><strong>1.3</strong>");
    expect(getRows(response.body)).toEqual([["Alice &lt;Collector&gt;", "2"], ["Robert M\u00fcller", "1"], [cara, "1"]]);
    expect(response.body).not.toContain("not-activated@example.test");
    expect(db.artwork.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "activated" }) }));
  });

  it.each([
    ["ROBERT MULLER", "Robert M\u00fcller", "1"],
    ["collector", "Alice &lt;Collector&gt;", "2"],
    ["@irisalice", "Alice &lt;Collector&gt;", "2"],
    ["BOB@EXAMPLE.TEST", "Robert M\u00fcller", "1"],
    ["AR-007", "Robert M\u00fcller", "1"],
    ["IRIS No. 1501", "Alice &lt;Collector&gt;", "2"],
    ["IRIS-1503", cara, "1"]
  ])("finds %s without changing the owner's total holdings", async (query, name, count) => {
    const response = await get(`/admin/owners?${new URLSearchParams({ q: query })}`);
    expect(getRows(response.body)).toEqual([[name, count]]);
    expect(response.body).toContain("Total Owners</span><strong>3</strong>");
  });

  it("sorts and searches across all pages with a stable email tie-break", async () => {
    const many = Array.from({ length: 51 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return artwork(`IRIS-${suffix}`, `owner${suffix}@example.test`);
    });
    db.artwork.findMany.mockResolvedValue([...owned, ...many]);
    const ascending = await get("/admin/owners?sort=asc");
    expect(ascending.body).toContain('aria-sort="ascending"');
    expect(ascending.body).toContain('href="/admin/owners?sort=asc&amp;page=2" rel="next"');
    expect(getRows(ascending.body)).toHaveLength(50);
    expect(getRows(ascending.body)[0]).toEqual(["Robert M\u00fcller", "1"]);
    const last = await get("/admin/owners?sort=asc&page=99");
    expect(getRows(last.body).at(-1)).toEqual(["Alice &lt;Collector&gt;", "2"]);
    expect(last.body).toContain("51&ndash;54 of 54");
    expect(last.body).not.toContain('rel="next"');
    const search = await get("/admin/owners?sort=asc&q=owner50");
    expect(getRows(search.body)).toEqual([["owner50@example.test", "1"]]);
    expect(search.body).toContain('name="sort" value="asc"');
  });

  it("escapes search input and shows empty states", async () => {
    const response = await get(`/admin/owners?${new URLSearchParams({ q: '\"><script>alert(1)</script>', sort: 'bad', page: 'bad' })}`);
    expect(response.body).toContain("No matching owners");
    expect(response.body).toContain('aria-sort="descending"');
    expect(response.body).not.toContain("<script>alert(1)</script>");
    db.artwork.findMany.mockResolvedValue([]);
    expect((await get("/admin/owners")).body).toContain("No IRIS owners yet");
  });

  it("opens existing customer details with current and historical IRIS separated", async () => {
    db.artwork.findMany.mockResolvedValue(owned.filter((item) => item.owner_email?.toLowerCase() === alice || item.assigned_customer_email === alice));
    db.shopifyOrder.findMany.mockResolvedValue([]);
    const details = `/admin/customers/${encodeURIComponent(alice)}`;
    const response = await get(`${details}?from=owners&q=alice&sort=asc&page=2`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<h1>Alice &lt;Collector&gt;</h1>");
    expect(response.body).toContain("IRIS Held</span><strong>2</strong>");
    expect(response.body).toContain("Other Linked IRIS</span><strong>1</strong>");
    expect(response.body).toContain('href="/admin/owners?q=alice&amp;sort=asc&amp;page=2">Back to IRIS Owners');
    const [, holdings, other] = response.body.split(/<h2 class="admin-section-title">(?:IRIS Held|Other Linked IRIS)<\/h2>/);
    expect(holdings).toContain("IRIS-1501");
    expect(holdings).not.toContain("IRIS-1503");
    expect(other).toContain("IRIS-1503");
    expect((await get(details)).body).toContain("Back to Orders");
  });
});
