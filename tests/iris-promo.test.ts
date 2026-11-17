import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env.js", () => ({ env: {} }));
import { createIrisPromo, irisPromoCsrf, validIrisPromoCsrf } from "../src/iris-promo.js";

const credentials = { domain: "iris-test.myshopify.com", clientId: "test-id", clientSecret: "test-private-shopify-secret" };
const customerId = "gid://shopify/Customer/123";
const customer = { id: customerId, defaultEmailAddress: { emailAddress: "INFO@GUGOCO.COM" } };
const combine = { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false };
const active = (code: string) => ({
  __typename: "DiscountCodeBasic", title: "My IRIS - Private Pilot (10%)", status: "ACTIVE",
  usageLimit: 1, asyncUsageCount: 0, appliesOncePerCustomer: true, combinesWith: combine,
  codes: { nodes: [{ code }] }, context: { __typename: "DiscountCustomers", customers: [{ id: customerId }] },
  customerGets: { items: { __typename: "AllDiscountItems" }, value: { percentage: 0.1 } }
});
const json = (value: unknown) => new Response(JSON.stringify(value));
const token = (scope = "read_customers,write_discounts") => json({ access_token: "test-token", expires_in: 86400, scope });
const lookup = (discount: unknown = null, nodes = [customer]) => json({ data: {
  customers: { nodes, pageInfo: { hasNextPage: false } },
  codeDiscountNodeByCode: discount ? { codeDiscount: discount } : null
} });
const parse = (init?: RequestInit) => JSON.parse(String(init?.body));
const fetchMock = vi.fn<typeof fetch>();
let promo: ReturnType<typeof createIrisPromo>;

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); promo = createIrisPromo(credentials); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("My IRIS Shopify promo", () => {
  it("binds the CSRF proof to the active session", () => {
    expect(validIrisPromoCsrf(irisPromoCsrf("a"), "a")).toBe(true);
    expect(validIrisPromoCsrf(irisPromoCsrf("a"), "b")).toBe(false);
    expect(validIrisPromoCsrf([irisPromoCsrf("a")], "a")).toBe(false);
  });

  it("creates one customer-specific 10% discount and reuses it on concurrent or subsequent clicks", async () => {
    let discount: ReturnType<typeof active> | null = null;
    let writes = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("access_token")) return token();
      const { query, variables } = parse(init);
      expect(init?.headers).toMatchObject({ "X-Shopify-Access-Token": "test-token" });
      if (query.includes("query IrisPromoLookup")) {
        expect(variables.search).toBe('email:"info@gugoco.com"');
        return lookup(discount);
      }
      writes++;
      expect(variables.input).toMatchObject({
        context: { customers: { add: [customerId] } }, usageLimit: 1, appliesOncePerCustomer: true,
        customerGets: { value: { percentage: 0.1 }, items: { all: true } }, combinesWith: combine
      });
      discount = active(variables.input.code);
      return json({ data: { discountCodeBasicCreate: { codeDiscountNode: { codeDiscount: discount }, userErrors: [] } } });
    });
    const [first, second] = await Promise.all([promo.redeem(), promo.redeem()]);
    expect(first).toMatchObject({ code: expect.stringMatching(/^IRIS-[A-F0-9]{20}$/), percent: 10 });
    expect(second).toEqual(first);
    expect(await createIrisPromo(credentials).redeem()).toEqual(first);
    expect(writes).toBe(1);
  });

  it.each([[], [{ ...customer, defaultEmailAddress: { emailAddress: "unmatched@example.test" } }], [customer, customer]].map(nodes => [nodes] as const))(
    "refuses to create a discount without one exact customer match (%j)", async (nodes) => {
      fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(lookup(null, nodes));
      await expect(promo.redeem()).rejects.toMatchObject({ code: "customer" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it("reports a missing scope before touching Shopify discount resources", async () => {
    fetchMock.mockResolvedValueOnce(token("read_customers,write_products"));
    await expect(promo.check()).rejects.toMatchObject({ code: "scope" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes protected customer-data denial from connection failure without exposing upstream details", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ errors: [
      { message: "private upstream detail", extensions: { code: "ACCESS_DENIED" } }
    ] }));
    await expect(promo.check()).rejects.toMatchObject({ code: "scope", diagnostic: "graphql_access_denied", message: "Shopify blocked access to discounts or customer data." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a redacted Shopify email as an unverified customer", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ data: {
      customers: { nodes: [{ id: customerId, defaultEmailAddress: { emailAddress: null } }], pageInfo: { hasNextPage: false } },
      codeDiscountNodeByCode: null
    } }));
    await expect(promo.redeem()).rejects.toMatchObject({ code: "customer" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checks the setup without issuing a code", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(lookup());
    await promo.check();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parse(fetchMock.mock.calls[1][1]).query).not.toContain("mutation");
  });

  it("reads the original code after an uncertain mutation instead of creating another", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(lookup()).mockRejectedValueOnce(new Error("timeout"));
    fetchMock.mockImplementationOnce(async (_url, init) => lookup(active(parse(init).variables.code)));
    expect(await promo.redeem()).toMatchObject({ percent: 10 });
    const requests = fetchMock.mock.calls.slice(1).map(([, init]) => parse(init));
    expect(requests[0].variables.code).toBe(requests[1].variables.input.code);
    expect(requests[1].variables.input.code).toBe(requests[2].variables.code);
    expect(requests.filter((req) => req.query.startsWith("mutation"))).toHaveLength(1);
  });

  it.each([
    ["used", { asyncUsageCount: 1 }],
    ["inactive", { status: "EXPIRED" }],
    ["mismatch", { context: { __typename: "DiscountCustomers", customers: [{ id: "gid://shopify/Customer/456" }] } }],
    ["mismatch", { usageLimit: 2 }],
    ["mismatch", { combinesWith: { ...combine, orderDiscounts: true } }]
  ])("does not disclose or recreate an existing %s discount", async (errorCode, changes) => {
    fetchMock.mockResolvedValueOnce(token());
    fetchMock.mockImplementationOnce(async (_url, init) => lookup({ ...active(parse(init).variables.code), ...changes }));
    await expect(promo.redeem()).rejects.toMatchObject({ code: errorCode });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
