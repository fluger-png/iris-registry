import { Prisma } from "@prisma/client";

import { prisma } from "../src/db.js";
import { env } from "../src/env.js";

const args = process.argv.slice(2);

const getArg = (flag: string): string | null => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
};

const hasFlag = (flag: string): boolean => args.includes(flag);

const normalizeOrderNumber = (value: string): string => value.trim();
const orderNumberVariants = (value: string): string[] => {
  const clean = normalizeOrderNumber(value);
  return Array.from(new Set([clean, clean.startsWith("#") ? clean.slice(1) : `#${clean}`]));
};

const payloadObject = (value: Prisma.JsonValue): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const shopifyGraphQL = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
  const response = await fetch(
    `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.shopifyAdminToken
      },
      body: JSON.stringify({ query, variables })
    }
  );
  const data = (await response.json()) as { data?: T; errors?: unknown };
  if (!response.ok || data.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors ?? data)}`);
  }
  if (!data.data) {
    throw new Error("Shopify GraphQL returned no data");
  }
  return data.data;
};

type ShopifyOrderNode = {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  email: string | null;
};

const findShopifyOrderByName = async (orderNumber: string): Promise<ShopifyOrderNode | null> => {
  const query = `
    query FindOrderByName($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          id
          name
          createdAt
          processedAt
          email
        }
      }
    }
  `;
  const clean = normalizeOrderNumber(orderNumber);
  const withoutHash = clean.replace(/^#/, "");
  const queries = Array.from(new Set([`name:${withoutHash}`, `name:${clean}`, clean]));

  for (const shopifyQuery of queries) {
    const data = await shopifyGraphQL<{ orders: { nodes: ShopifyOrderNode[] } }>(query, {
      query: shopifyQuery
    });
    const order = data.orders.nodes[0] ?? null;
    if (order) {
      return order;
    }
  }

  return null;
};

const limit = Math.max(1, Math.min(Number(getArg("--limit") ?? 250), 1000));
const onlyOrderNumber = getArg("--order-number");
const dryRun = hasFlag("--dry-run");

const run = async () => {
  const artworks = await prisma.artwork.findMany({
    where: {
      assigned_order_id: onlyOrderNumber
        ? { in: orderNumberVariants(onlyOrderNumber) }
        : { not: null }
    },
    select: {
      iris_id: true,
      assigned_order_id: true,
      assigned_customer_email: true
    },
    orderBy: { updated_at: "desc" },
    take: limit
  });

  let checked = 0;
  let updatedDates = 0;
  let updatedEmails = 0;
  let missing = 0;

  for (const artwork of artworks) {
    checked += 1;
    const orderNumber = artwork.assigned_order_id;
    if (!orderNumber) {
      continue;
    }

    const event = await prisma.event.findFirst({
      where: { iris_id: artwork.iris_id, type: "assigned" },
      orderBy: { created_at: "desc" }
    });
    if (!event) {
      missing += 1;
      console.log(`Missing assigned event for ${artwork.iris_id} (${orderNumber})`);
      continue;
    }

    const payload = payloadObject(event.payload_json);
    const shopifyOrder = await findShopifyOrderByName(orderNumber);
    if (!shopifyOrder) {
      missing += 1;
      console.log(`Shopify order not found for ${artwork.iris_id} (${orderNumber})`);
      continue;
    }

    const nextPayload = {
      ...payload,
      order_created_at: shopifyOrder.createdAt,
      shopify_order_gid: shopifyOrder.id,
      shopify_order_name: shopifyOrder.name
    };
    const needsDate = payload.order_created_at !== shopifyOrder.createdAt;
    const currentEmail = artwork.assigned_customer_email?.trim().toLowerCase() ?? "";
    const shopifyEmail = shopifyOrder.email?.trim().toLowerCase() ?? "";
    const shouldFixPlaceholderEmail =
      shopifyEmail && (!currentEmail || currentEmail === "email_from_order");

    if (dryRun) {
      console.log(
        `[dry-run] ${artwork.iris_id} ${orderNumber}: date ${payload.order_created_at ?? "-"} -> ${
          shopifyOrder.createdAt
        }${shouldFixPlaceholderEmail ? `, email ${currentEmail || "-"} -> ${shopifyEmail}` : ""}`
      );
      continue;
    }

    if (needsDate) {
      await prisma.event.update({
        where: { event_id: event.event_id },
        data: { payload_json: nextPayload }
      });
      updatedDates += 1;
    }

    if (shouldFixPlaceholderEmail) {
      await prisma.artwork.update({
        where: { iris_id: artwork.iris_id },
        data: { assigned_customer_email: shopifyEmail }
      });
      await prisma.event.create({
        data: {
          iris_id: artwork.iris_id,
          type: "manual_recovery_email_corrected",
          actor: "order_date_backfill",
          payload_json: {
            order_number: shopifyOrder.name,
            corrected_email: shopifyEmail,
            previous_email: artwork.assigned_customer_email,
            reason: "placeholder email corrected from Shopify order during order date backfill"
          }
        }
      });
      updatedEmails += 1;
    }

    console.log(
      `${artwork.iris_id} ${orderNumber}: ${needsDate ? "date updated" : "date ok"}${
        shouldFixPlaceholderEmail ? ", email corrected" : ""
      }`
    );
  }

  console.log(
    JSON.stringify(
      {
        checked,
        updated_dates: updatedDates,
        updated_placeholder_emails: updatedEmails,
        missing
      },
      null,
      2
    )
  );
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
