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
  quantity: number;
  reservationTokens: string[];
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

  return lineItems.map((item) => {
    const rawQuantity = Number(item.quantity ?? 1);
    const properties = item.properties as Array<{ name?: string; value?: string }> | undefined;
    const reservationTokens: string[] = [];
    if (Array.isArray(properties)) {
      for (const prop of properties) {
        const name = prop?.name?.toString().trim().toLowerCase();
        if (!name || !tokenKeys.has(name)) {
          continue;
        }
        const value = prop?.value?.toString().trim();
        if (value) {
          reservationTokens.push(value);
        }
      }
    }

    const productId =
      typeof item.product_id === "number" || typeof item.product_id === "string"
        ? String(item.product_id)
        : null;
    const handle = typeof item.handle === "string" && item.handle.trim() ? item.handle.trim() : null;
    return {
      productId,
      handle,
      quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.floor(rawQuantity) : 1,
      reservationTokens: Array.from(new Set(reservationTokens))
    };
  });
};
