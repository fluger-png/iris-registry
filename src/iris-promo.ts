import crypto from "node:crypto";
import { env } from "./env.js";
import { createShopifyAdminClient, ShopifyAdminError, type ShopifyAppCredentials } from "./shopify-admin-client.js";

const PILOT_EMAIL = "info@gugoco.com";
const PROMO_PERCENT = 10;
const TITLE = "My IRIS - Private Pilot (10%)";
const SCOPES = ["read_customers", "write_discounts"] as const;
const COMBINATIONS = { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false };

export const canRedeemIrisPromo = (email: string): boolean => email.trim().toLowerCase() === PILOT_EMAIL;
export const irisPromoCsrf = (sessionHash: string): string =>
  crypto.createHmac("sha256", sessionHash).update("iris-promo-redeem:v1").digest("hex");
export const validIrisPromoCsrf = (value: unknown, sessionHash: string): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
  crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(irisPromoCsrf(sessionHash), "hex"));

export class IrisPromoError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}

const DISCOUNT_FIELDS = `
  __typename
  ... on DiscountCodeBasic {
    title status usageLimit appliesOncePerCustomer asyncUsageCount
    codes(first: 1) { nodes { code } }
    context { __typename ... on DiscountCustomers { customers { id } } }
    customerGets { items { __typename } value { ... on DiscountPercentage { percentage } } }
    combinesWith { orderDiscounts productDiscounts shippingDiscounts }
  }`;

type Discount = {
  __typename: string; title: string; status: string; usageLimit: number; appliesOncePerCustomer: boolean;
  asyncUsageCount: number; codes: { nodes: { code: string }[] };
  context: { __typename: string; customers?: { id: string }[] };
  customerGets: { items: { __typename: string }; value: { percentage?: number } };
  combinesWith: typeof COMBINATIONS;
};

export const createIrisPromo = (credentials: ShopifyAppCredentials) => {
  const admin = createShopifyAdminClient(credentials);
  let pending: Promise<{ code: string; percent: number }> | null = null;
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    try { return await admin.graphql<T>(query, variables, SCOPES); }
    catch (error) {
      if (error instanceof ShopifyAdminError && error.code === "scope") {
        throw new IrisPromoError("scope", "Shopify discount permissions are not enabled yet.");
      }
      throw new IrisPromoError("connection", "Shopify is temporarily unavailable. Please try again.");
    }
  };

  const lookup = async () => {
    // A stable, unguessable code makes retries safe even across processes and deploys.
    const code = `IRIS-${crypto.createHmac("sha256", credentials.clientSecret).update(`iris-promo-pilot:v1:${PILOT_EMAIL}`).digest("hex").slice(0, 20).toUpperCase()}`;
    const data = await graphql<{
      customers: { nodes: { id: string; defaultEmailAddress: { emailAddress: string } | null }[]; pageInfo: { hasNextPage: boolean } };
      codeDiscountNodeByCode: { codeDiscount: Discount } | null;
    }>(`query IrisPromoLookup($search: String!, $code: String!) {
      customers(first: 2, query: $search) { nodes { id defaultEmailAddress { emailAddress } } pageInfo { hasNextPage } }
      codeDiscountNodeByCode(code: $code) { codeDiscount { ${DISCOUNT_FIELDS} } }
    }`, { search: `email:"${PILOT_EMAIL}"`, code });
    const matches = data.customers.nodes.filter((customer) => customer.defaultEmailAddress?.emailAddress.trim().toLowerCase() === PILOT_EMAIL);
    if (data.customers.pageInfo.hasNextPage || matches.length !== 1 || !/^gid:\/\/shopify\/Customer\/\d+$/.test(matches[0].id)) {
      throw new IrisPromoError("customer", "Could not verify the matching Shopify customer.", 409);
    }
    return { code, customerId: matches[0].id, existing: data.codeDiscountNodeByCode?.codeDiscount };
  };

  const confirm = (discount: Discount, code: string, customerId: string) => {
    if (discount.__typename !== "DiscountCodeBasic" || discount.title !== TITLE ||
        discount.usageLimit !== 1 || discount.appliesOncePerCustomer !== true ||
        discount.context?.__typename !== "DiscountCustomers" || discount.context.customers?.length !== 1 ||
        discount.context.customers[0].id !== customerId || discount.codes?.nodes[0]?.code !== code ||
        discount.customerGets?.items.__typename !== "AllDiscountItems" || discount.customerGets.value.percentage !== PROMO_PERCENT / 100 ||
        !discount.combinesWith || Object.keys(COMBINATIONS).some((key) => discount.combinesWith[key as keyof typeof COMBINATIONS] !== false)) {
      throw new IrisPromoError("mismatch", "The Shopify discount settings could not be verified.", 409);
    }
    if (discount.asyncUsageCount > 0) throw new IrisPromoError("used", "Your test discount has already been used.", 409);
    if (discount.status !== "ACTIVE") throw new IrisPromoError("inactive", "This test discount is not active in Shopify.", 409);
    return { code, percent: PROMO_PERCENT };
  };

  const issue = async () => {
    const { code, customerId, existing } = await lookup();
    if (existing) return confirm(existing, code, customerId);

    let created: Discount | undefined;
    try {
      const data = await graphql<{ discountCodeBasicCreate: { codeDiscountNode: { codeDiscount: Discount } | null; userErrors: unknown[] } }>(
        `mutation IrisPromoCreate($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { codeDiscount { ${DISCOUNT_FIELDS} } } userErrors { field message } }
        }`, { input: {
          title: TITLE, code, startsAt: new Date(Date.now() - 60_000).toISOString(),
          context: { customers: { add: [customerId] } },
          customerGets: { value: { percentage: PROMO_PERCENT / 100 }, items: { all: true } },
          usageLimit: 1, appliesOncePerCustomer: true, combinesWith: COMBINATIONS
        } });
      if (!data.discountCodeBasicCreate.userErrors.length) created = data.discountCodeBasicCreate.codeDiscountNode?.codeDiscount;
    } catch { /* Shopify may have written before timing out. Read back the same code. */ }
    if (created) return confirm(created, code, customerId);
    const retry = await lookup();
    if (retry.existing && retry.customerId === customerId) return confirm(retry.existing, code, customerId);
    throw new IrisPromoError("unconfirmed", "Shopify did not confirm the discount. Please try again.");
  };

  return {
    // A production check can verify the credentials and customer without creating a discount.
    check: async () => { await lookup(); },
    redeem: async () => {
      if (pending) return pending;
      pending = issue();
      try { return await pending; } finally { pending = null; }
    }
  };
};

export const irisPromo = createIrisPromo({
  domain: env.shopifyAuthShopDomain ?? "", clientId: env.shopifyClientId ?? "", clientSecret: env.shopifyClientSecret ?? ""
});
