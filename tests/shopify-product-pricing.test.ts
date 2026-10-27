import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/env.js", () => ({ env: {} }));
import { createProductPricingClient, parsePriceCents, priceRevision, validPriceRevision, ReadyPrice } from "../src/shopify-product-pricing.js";

const credentials = { domain: "iris-test.myshopify.com", clientId: "test-id", clientSecret: "never-print-this-secret" };
const binding = { id: "ararat", shopify_handle: "ararat-heart", shopify_product_id: null };
const ready: ReadyPrice = { ready: true, productId: "gid://shopify/Product/100", variantId: "gid://shopify/ProductVariant/200", handle: "ararat-heart", priceCents: 12000, currency: "USD", updatedAt: "2026-10-26T20:00:00Z" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const authResponse = () => json({ access_token: "private-token", expires_in: 86400, scope: "write_products" });
const productData = (price = "120.00") => ({ shop: { currencyCode: "USD" }, products: { nodes: [{ id: ready.productId, handle: ready.handle, variants: { nodes: [{ id: ready.variantId, price, updatedAt: ready.updatedAt }] } }] } });
const productResponse = (price = "120.00") => json({ data: productData(price) });
const fetchMock = vi.fn<typeof fetch>();
let client: ReturnType<typeof createProductPricingClient>;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  client = createProductPricingClient(credentials);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Shopify product pricing", () => {
  it("parses money without floating-point rounding or permissive number coercion", () => {
    for (const [value, cents] of [["120", 12000], ["120.50", 12050], ["0.01", 1], ["0", 0], ["999999.99", 99999999]] as const) expect(parsePriceCents(value)).toBe(cents);
    for (const value of ["", "-1", "1e3", "NaN", "12.345", "1,200", " 120 ", "01", ".5", "1000000", 120, ["120"]]) expect(parsePriceCents(value)).toBeNull();
  });

  it("binds revisions to the session, collection and fresh Shopify state", () => {
    const signature = priceRevision("session", "ararat", ready);
    expect(validPriceRevision(signature, "session", "ararat", ready)).toBe(true);
    expect(validPriceRevision(signature, "other", "ararat", ready)).toBe(false);
    expect(validPriceRevision(signature, "session", "sayat", ready)).toBe(false);
    expect(validPriceRevision(signature, "session", "ararat", { ...ready, updatedAt: "later" })).toBe(false);
    expect(validPriceRevision("invalid", "session", "ararat", ready)).toBe(false);
  });

  it("reuses a token and refreshes it before expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    fetchMock.mockImplementation(async (url) => String(url).endsWith("access_token") ? authResponse() : productResponse());
    await client.read(binding);
    await client.read(binding);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("access_token"))).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-26T23:59:30Z"));
    await client.read(binding);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("access_token"))).toHaveLength(2);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("deduplicates simultaneous token requests", async () => {
    fetchMock.mockImplementation(async (url) => String(url).endsWith("access_token") ? authResponse() : productResponse());
    await Promise.all([client.read(binding), client.read(binding)]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("access_token"))).toHaveLength(1);
  });

  it("refreshes once on 401, never retries indefinitely", async () => {
    fetchMock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(json({}, 401));
    await expect(client.read(binding)).rejects.toMatchObject({ code: "connection" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects missing write scope and never exposes OAuth bodies", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "private-token", expires_in: 86400, scope: "read_products" }));
    await expect(client.read(binding)).rejects.toMatchObject({ code: "scope" });
    fetchMock.mockResolvedValueOnce(json({ message: credentials.clientSecret }, 401));
    const state = await client.inspect(binding);
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toContain(credentials.clientSecret);
    expect(JSON.stringify(state)).not.toContain("private-token");
  });

  it("rejects non-Shopify endpoints before sending credentials", async () => {
    const invalid = createProductPricingClient({ ...credentials, domain: "example.com" });
    expect((await invalid.inspect(binding)).ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches the exact product handle and verifies an existing product binding", async () => {
    fetchMock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(productResponse());
    expect(await client.read(binding)).toEqual(ready);
    fetchMock.mockResolvedValueOnce(productResponse());
    await expect(client.read({ ...binding, shopify_product_id: "999" })).rejects.toMatchObject({ code: "binding" });
    const data = productData();
    data.products.nodes[0].handle = "ararat-heart-other";
    fetchMock.mockResolvedValueOnce(json({ data }));
    await expect(client.read(binding)).rejects.toMatchObject({ code: "binding" });
  });

  it("disables ambiguous multi-variant products and unsupported currencies", async () => {
    const variants = productData();
    variants.products.nodes[0].variants.nodes.push({ ...variants.products.nodes[0].variants.nodes[0], id: "gid://shopify/ProductVariant/201" });
    fetchMock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(json({ data: variants }));
    await expect(client.read(binding)).rejects.toMatchObject({ code: "variants" });
    const currency = productData();
    currency.shop.currencyCode = "EUR";
    fetchMock.mockResolvedValueOnce(json({ data: currency }));
    await expect(client.read(binding)).rejects.toMatchObject({ code: "currency" });
  });

  it("writes only variant price and reads it back before confirming", async () => {
    fetchMock.mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(json({ data: { productVariantsBulkUpdate: { userErrors: [], productVariants: [{ id: ready.variantId, price: "130.50" }] } } }))
      .mockResolvedValueOnce(productResponse("130.50"));
    expect((await client.update(binding, ready, 13050)).priceCents).toBe(13050);
    const request = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(request.variables).toEqual({ productId: ready.productId, variants: [{ id: ready.variantId, price: "130.50" }] });
    expect(request.query).toContain("allowPartialUpdates: false");
    expect(request.query).not.toContain("inventory");
  });

  it("does not mutate an unchanged price", async () => {
    expect(await client.update(binding, ready, 12000)).toEqual(ready);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects zero, invalid and excessive write prices", async () => {
    for (const cents of [0, -1, 120.5, Infinity, NaN, 100000000]) await expect(client.update(binding, ready, cents)).rejects.toMatchObject({ code: "price" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces explicit Shopify rejection without a misleading success", async () => {
    fetchMock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(json({ data: { productVariantsBulkUpdate: { userErrors: [{ message: "Not allowed" }], productVariants: [] } } }));
    await expect(client.update(binding, ready, 13000)).rejects.toMatchObject({ code: "rejected", status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reconciles a mutation timeout by reading back, without replaying the mutation", async () => {
    fetchMock.mockResolvedValueOnce(authResponse()).mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(productResponse("130.00"));
    expect((await client.update(binding, ready, 13000)).priceCents).toBe(13000);
    expect(fetchMock.mock.calls.filter(([, options]) => String(options?.body).includes("mutation CollectionPriceUpdate"))).toHaveLength(1);
  });

  it("reports an unconfirmed outcome when Shopify read-back differs", async () => {
    fetchMock.mockResolvedValueOnce(authResponse()).mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(productResponse("120.00"));
    await expect(client.update(binding, ready, 13000)).rejects.toMatchObject({ code: "unconfirmed" });
  });
});
