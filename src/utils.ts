import crypto from "node:crypto";

export const verifyShopifyHmac = (rawBody: Buffer, secret: string, receivedHmac: string): boolean => {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const safeReceived = Buffer.from(receivedHmac, "utf8");
  const safeDigest = Buffer.from(digest, "utf8");
  if (safeReceived.length !== safeDigest.length) {
    return false;
  }
  return crypto.timingSafeEqual(safeReceived, safeDigest);
};

export type Cursor = { sortAt: string; irisId: string };

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeCursor = (value: string): Cursor => {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
  if (!parsed?.sortAt || !parsed?.irisId) {
    throw new Error("Invalid cursor");
  }
  return parsed;
};

export const parseReservationTokens = (order: unknown): string[] => {
  if (!order || typeof order !== "object") {
    return [];
  }
  const lineItems = (order as { line_items?: Array<Record<string, unknown>> }).line_items;
  if (!Array.isArray(lineItems)) {
    return [];
  }
  const tokenKeys = new Set([
    "reservationtoken",
    "reservation_token",
    "iris_reservation_token",
    "iris-reservation-token"
  ]);
  const tokens: string[] = [];
  for (const item of lineItems) {
    const properties = item.properties as Array<{ name?: string; value?: string }> | undefined;
    if (!Array.isArray(properties)) {
      continue;
    }
    for (const prop of properties) {
      const name = prop?.name?.toString().trim();
      if (!name) {
        continue;
      }
      const normalized = name.toLowerCase();
      if (tokenKeys.has(normalized)) {
        const value = prop?.value?.toString().trim();
        if (value) {
          tokens.push(value);
        }
      }
    }
  }
  return Array.from(new Set(tokens));
};

export type ShopifyLineItemSummary = {
  productId: string | null;
  handle: string | null;
  title: string | null;
  name: string | null;
  sku: string | null;
  variantTitle: string | null;
  quantity: number;
  irisIds: string[];
  collectionSlugs: string[];
  reservationTokens: string[];
};

const readLineItemString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

export const parseShopifyLineItems = (order: unknown): ShopifyLineItemSummary[] => {
  if (!order || typeof order !== "object") {
    return [];
  }
  const lineItems = (order as { line_items?: Array<Record<string, unknown>> }).line_items;
  if (!Array.isArray(lineItems)) {
    return [];
  }
  const tokenKeys = new Set([
    "reservationtoken",
    "reservation_token",
    "iris_reservation_token",
    "iris-reservation-token"
  ]);
  const irisIdKeys = new Set([
    "iris_id",
    "iris-id",
    "_iris_id",
    "_iris-id"
  ]);
  const collectionSlugKeys = new Set([
    "iris_collection_slug",
    "iris-collection-slug",
    "_iris_collection_slug",
    "_iris-collection-slug",
    "collection_slug",
    "collection-slug"
  ]);
  const productHandleKeys = new Set([
    "product_handle",
    "product-handle",
    "_iris_product_handle",
    "_iris-product-handle"
  ]);

  return lineItems.map((item) => {
    const rawQuantity = Number(item.quantity ?? 1);
    const properties = item.properties as Array<{ name?: string; value?: string }> | undefined;
    const reservationTokens: string[] = [];
    const irisIds: string[] = [];
    const collectionSlugs: string[] = [];
    let propertyProductHandle: string | null = null;
    if (Array.isArray(properties)) {
      for (const prop of properties) {
        const name = prop?.name?.toString().trim().toLowerCase();
        if (!name) {
          continue;
        }
        const value = prop?.value?.toString().trim();
        if (!value) {
          continue;
        }
        if (tokenKeys.has(name)) {
          reservationTokens.push(value);
        } else if (irisIdKeys.has(name)) {
          irisIds.push(value);
        } else if (collectionSlugKeys.has(name)) {
          collectionSlugs.push(value);
        } else if (productHandleKeys.has(name)) {
          propertyProductHandle = value;
        }
      }
    }

    const productId = readLineItemString(item.product_id);
    const itemHandle = readLineItemString(item.handle) ?? readLineItemString(item.product_handle);
    const handle = itemHandle ?? propertyProductHandle;
    return {
      productId,
      handle,
      title: readLineItemString(item.title),
      name: readLineItemString(item.name),
      sku: readLineItemString(item.sku),
      variantTitle: readLineItemString(item.variant_title),
      quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.floor(rawQuantity) : 1,
      irisIds: Array.from(new Set(irisIds)),
      collectionSlugs: Array.from(new Set(collectionSlugs)),
      reservationTokens: Array.from(new Set(reservationTokens))
    };
  });
};
