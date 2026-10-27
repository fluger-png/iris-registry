import crypto from "node:crypto";
import { env } from "./env.js";

type Credentials = { domain: string; clientId: string; clientSecret: string };
type CollectionBinding = { id: string; shopify_handle: string | null; shopify_product_id: string | null };
export type ReadyPrice = {
  ready: true; productId: string; variantId: string; handle: string;
  priceCents: number; currency: "USD"; updatedAt: string;
};
export type CollectionPriceState = ReadyPrice | { ready: false; message: string };

export class CollectionPriceError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}

export const parsePriceCents = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, cents = ""] = value.split(".");
  return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
};

export const priceRevision = (sessionHash: string, collectionId: string, price: ReadyPrice) =>
  crypto.createHmac("sha256", sessionHash).update(JSON.stringify([
    "collection-price", collectionId, price.productId, price.variantId, price.priceCents, price.currency, price.updatedAt
  ])).digest("hex");

export const validPriceRevision = (value: unknown, sessionHash: string, collectionId: string, price: ReadyPrice) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
  crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(priceRevision(sessionHash, collectionId, price), "hex"));

// This client is deliberately separate from order/customer integration and webhook credentials.
export const createProductPricingClient = (credentials: Credentials) => {
  const configured = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(credentials.domain) &&
    Boolean(credentials.clientId && credentials.clientSecret);
  let cached: { value: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  const unavailable = () => new CollectionPriceError("connection", "Shopify pricing is temporarily unavailable. Please try again shortly.");
  const token = async (): Promise<string> => {
    if (!configured) throw unavailable();
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(`https://${credentials.domain}/admin/oauth/access_token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret })
        });
        if (!response.ok) throw unavailable();
        const data = await response.json() as { access_token?: unknown; expires_in?: unknown; scope?: unknown };
        if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" ||
          !Number.isFinite(data.expires_in) || data.expires_in <= 60) throw unavailable();
        if (typeof data.scope !== "string" || !data.scope.split(",").map((scope) => scope.trim()).includes("write_products")) {
          throw new CollectionPriceError("scope", "Shopify product editing permission is unavailable.");
        }
        cached = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        return cached.value;
      } catch (error) {
        // Never include OAuth response bodies, credentials or tokens in errors/logs.
        if (error instanceof CollectionPriceError) throw error;
        throw unavailable();
      }
    })();
    try { return await pending; } finally { pending = null; }
  };

  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const usedToken = await token();
      let response: Response;
      try {
        response = await fetch(`https://${credentials.domain}/admin/api/2026-10/graphql.json`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": usedToken },
          body: JSON.stringify({ query, variables })
        });
      } catch { throw unavailable(); }
      if (response.status === 401 && attempt === 0) {
        if (cached?.value === usedToken) cached = null;
        continue;
      }
      if (!response.ok) throw unavailable();
      try {
        const result = await response.json() as { data?: T; errors?: unknown[] };
        if (result.errors?.length || !result.data) throw unavailable();
        return result.data;
      } catch { throw unavailable(); }
    }
    throw unavailable();
  };

  const read = async (collection: CollectionBinding): Promise<ReadyPrice> => {
    const handle = collection.shopify_handle;
    if (!handle || !/^[a-z0-9-]+$/.test(handle)) throw new CollectionPriceError("binding", "This collection has no verified Shopify product.");
    const data = await graphql<{
      shop: { currencyCode: string };
      products: { nodes: Array<{ id: string; handle: string; variants: { nodes: Array<{ id: string; price: string; updatedAt: string }> } }> };
    }>(`query CollectionPrice($query: String!) {
      shop { currencyCode }
      products(first: 2, query: $query) { nodes { id handle variants(first: 2) { nodes { id price updatedAt } } } }
    }`, { query: `handle:${handle}` });
    const products = data.products.nodes.filter((product) => product.handle === handle);
    const product = products[0];
    const boundId = collection.shopify_product_id?.replace(/^gid:\/\/shopify\/Product\//, "");
    if (products.length !== 1 || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id) ||
      (boundId && product.id !== `gid://shopify/Product/${boundId}`)) {
      throw new CollectionPriceError("binding", "The Shopify product does not match this collection.");
    }
    if (product.variants.nodes.length !== 1) throw new CollectionPriceError("variants", "Products with multiple variants must be priced in Shopify.");
    const variant = product.variants.nodes[0];
    const priceCents = parsePriceCents(variant.price);
    if (priceCents === null || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id) || !variant.updatedAt) throw unavailable();
    if (data.shop.currencyCode !== "USD") throw new CollectionPriceError("currency", "This price editor supports the store's USD base price only.");
    return { ready: true, productId: product.id, variantId: variant.id, handle, priceCents, currency: "USD", updatedAt: variant.updatedAt };
  };

  const inspect = async (collection: CollectionBinding): Promise<CollectionPriceState> => {
    try { return await read(collection); }
    catch (error) { return { ready: false, message: error instanceof CollectionPriceError ? error.message : unavailable().message }; }
  };

  const update = async (collection: CollectionBinding, current: ReadyPrice, cents: number): Promise<ReadyPrice> => {
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 99_999_999) throw new CollectionPriceError("price", "Enter a price from $0.01 to $999,999.99.", 400);
    if (current.priceCents === cents) return current;
    try {
      const result = await graphql<{ productVariantsBulkUpdate: { userErrors: unknown[]; productVariants: Array<{ id: string; price: string }> } }>(
        `mutation CollectionPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
            productVariants { id price } userErrors { field message }
          }
        }`, { productId: current.productId, variants: [{ id: current.variantId, price: (cents / 100).toFixed(2) }] }
      );
      if (result.productVariantsBulkUpdate.userErrors.length) {
        throw new CollectionPriceError("rejected", "Shopify rejected this price. Check the product settings in Shopify.", 422);
      }
    } catch (error) {
      if (error instanceof CollectionPriceError && error.code === "rejected") throw error;
      // A timeout may happen after Shopify applied the mutation. Read back, never blindly retry it.
    }
    try {
      const confirmed = await read(collection);
      if (confirmed.productId === current.productId && confirmed.variantId === current.variantId && confirmed.priceCents === cents) return confirmed;
    } catch { /* Report an uncertain outcome below, not a false success. */ }
    throw new CollectionPriceError("unconfirmed", "Shopify has not confirmed this change. Reload to check the current price before trying again.");
  };
  return { read, inspect, update };
};

export const collectionPricing = createProductPricingClient({
  domain: env.shopifyAuthShopDomain ?? "", clientId: env.shopifyClientId ?? "", clientSecret: env.shopifyClientSecret ?? ""
});
