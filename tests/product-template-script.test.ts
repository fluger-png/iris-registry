import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), disconnect: vi.fn(), writeFile: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { collection: { findUnique: mocks.findUnique }, $disconnect: mocks.disconnect } }));
vi.mock("../src/env.js", () => ({ env: { shopifyAuthShopDomain: "iris-test.myshopify.com", shopifyClientId: "id", shopifyClientSecret: "private-secret" } }));
vi.mock("node:fs/promises", () => ({ default: { writeFile: mocks.writeFile } }));
const fetchMock = vi.fn<typeof fetch>();
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let suffix: string | null;
const product = () => ({ id: "gid://shopify/Product/123", handle: "the-art-of-adornment", title: "THE ART OF ADORNMENT", templateSuffix: suffix });
const json = (value: unknown) => new Response(JSON.stringify(value));
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  suffix = "iris";
  vi.stubEnv("DATABASE_URL", "postgresql://test@ep-aged-flower-ahtjeivv.c-3.us-east-1.aws.neon.tech/test");
  vi.stubGlobal("fetch", fetchMock);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.findUnique.mockResolvedValue({ slug: "the-art-of-adornment", shopify_handle: "the-art-of-adornment", shopify_product_id: "123" });
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith("access_token")) return json({ access_token: "private-token", scope: "write_products" });
    const body = JSON.parse(init?.body as string);
    if (body.query.startsWith("mutation")) { suffix = body.variables.product.templateSuffix; return json({ data: { productUpdate: { userErrors: [] } } }); }
    return json({ data: { product: product() } });
  });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExitCode; vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const run = async (args: string[] = []) => {
  process.argv = ["node", "assign-product-template.ts", ...args];
  await import("../scripts/assign-product-template.js");
  await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
};
const mutations = () => fetchMock.mock.calls.filter(([, init]) => typeof init?.body === "string" && init.body.includes('"query":"mutation'));

describe("scoped product template assignment", () => {
  it("defaults to a read-only OKG dry run", async () => {
    await run();
    expect(mutations()).toHaveLength(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain('"requested_template": "iris-okg"');
  });

  it("backs up and changes only the verified product template suffix", async () => {
    await run(["--handle", "the-art-of-adornment", "--apply"]);
    expect(error).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.stringContaining("product-template-the-art-of-adornment-before-"), expect.stringContaining('"templateSuffix": "iris"'), { mode: 0o600, flag: "wx" });
    expect(mutations()).toHaveLength(1);
    expect(JSON.parse(mutations()[0][1]?.body as string).variables).toEqual({ product: { id: "gid://shopify/Product/123", templateSuffix: "iris-okg" } });
    expect(log.mock.calls.flat().join(" ")).toContain("Confirmed:");
    expect(log.mock.calls.flat().join(" ")).not.toContain("private-token");
  });

  it("does nothing when the correct template is already assigned", async () => {
    suffix = "iris-okg";
    await run(["--apply"]);
    expect(mutations()).toHaveLength(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("refuses unknown products or an all-products operation", async () => {
    await run(["--all"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("refuses a different database before requesting credentials", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
    await run(["--apply"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Shopify product binding", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "private-token", scope: "write_products" }))
      .mockResolvedValueOnce(json({ data: { product: { ...product(), handle: "another-product" } } }));
    await run(["--apply"]);
    expect(mutations()).toHaveLength(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("does not overwrite a template changed by another editor", async () => {
    let reads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("access_token")) return json({ access_token: "token", scope: "write_products" });
      reads++;
      return json({ data: { product: { ...product(), templateSuffix: reads > 1 ? "another-template" : "iris" } } });
    });
    await run(["--apply"]);
    expect(mutations()).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });
});
