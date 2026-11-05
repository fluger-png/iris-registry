import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db.js";
import { env } from "../src/env.js";

const templates: Record<string, string> = {
  "iris-the-unseen-edition": "iris-unseen",
  "ararat-heart": "iris-ararat",
  "sayat-nova": "iris-sayat-nova",
  "the-art-of-adornment": "iris-okg"
};
type ProductTemplate = { id: string; handle: string; title: string; templateSuffix: string | null };

const run = async () => {
  const args = process.argv.slice(2);
  let handle = "the-art-of-adornment";
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--handle" && args[i + 1]) handle = args[++i];
    else throw new Error("Use --handle <collection-handle> and optionally --apply.");
  }
  const suffix = templates[handle];
  if (!suffix) throw new Error("This product has no approved collection template.");
  const host = new URL(process.env.DATABASE_URL || "").hostname;
  if (!host.startsWith("ep-aged-flower-ahtjeivv") || !host.endsWith(".neon.tech")) throw new Error("Run this in the active iris-registry Render Shell.");
  const collection = await prisma.collection.findUnique({ where: { slug: handle } });
  const id = collection?.shopify_product_id?.replace(/^gid:\/\/shopify\/Product\//, "");
  if (!collection || collection.shopify_handle !== handle || !id || !/^\d+$/.test(id)) throw new Error("No verified Shopify product binding. Nothing changed.");
  const domain = env.shopifyAuthShopDomain ?? "";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || !env.shopifyClientId || !env.shopifyClientSecret) throw new Error("Shopify product credentials are not configured.");
  const auth = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.shopifyClientId, client_secret: env.shopifyClientSecret })
  });
  if (!auth.ok) throw new Error("Shopify authorization failed. Nothing changed.");
  const credentials = await auth.json() as { access_token?: string; scope?: string };
  if (!credentials.access_token || !credentials.scope?.split(",").map(s => s.trim()).includes("write_products")) throw new Error("Shopify product editing scope is unavailable.");
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`https://${domain}/admin/api/2026-10/graphql.json`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": credentials.access_token! },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error("Shopify request failed; no confirmed template change.");
    const result = await response.json() as { data?: T; errors?: unknown[] };
    if (!result.data || result.errors?.length) throw new Error("Shopify request failed; no confirmed template change.");
    return result.data;
  };
  const productId = `gid://shopify/Product/${id}`;
  const read = async () => {
    const data = await graphql<{ product: ProductTemplate | null }>(`query ProductTemplate($id: ID!) { product(id: $id) { id handle title templateSuffix } }`, { id: productId });
    if (!data.product || data.product.id !== productId || data.product.handle !== handle) throw new Error("Shopify product identity differs from the collection. Nothing changed.");
    return data.product;
  };
  const before = await read();
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", product: before.title, handle, product_id: productId,
    previous_template: before.templateSuffix, requested_template: suffix }, null, 2));
  if (!apply) { console.log("Dry run only. Add --apply to assign this template to this product only."); return; }
  if (before.templateSuffix === suffix) { console.log("The product already uses this template. No change needed."); return; }
  const backup = path.resolve(`product-template-${handle}-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(backup, JSON.stringify(before, null, 2), { mode: 0o600, flag: "wx" });
  console.log(`Template-only backup: ${backup}`);
  if ((await read()).templateSuffix !== before.templateSuffix) throw new Error("The product template changed during setup. Reload and review before trying again.");
  let rejected = false;
  try {
    const result = await graphql<{ productUpdate: { userErrors: unknown[] } }>(
      `mutation ProductTemplate($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
      { product: { id: productId, templateSuffix: suffix } });
    rejected = result.productUpdate.userErrors.length > 0;
  } catch { /* A timeout may occur after Shopify applied the mutation. Read back; never blindly retry. */ }
  if (rejected) throw new Error("Shopify rejected the template assignment. Previous product settings preserved.");
  const confirmed = await read();
  if (confirmed.templateSuffix !== suffix) throw new Error("Template change unconfirmed. Check Shopify before retrying.");
  console.log(`Confirmed: ${handle} now uses ${suffix}. Prices, inventory and other products were not changed.`);
};

run().catch(error => { console.error(error instanceof Error ? error.message : "Product template setup failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
