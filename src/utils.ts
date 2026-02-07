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

export type Cursor = { activatedAt: string; irisId: string };

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

export const decodeCursor = (value: string): Cursor => {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
  if (!parsed?.activatedAt || !parsed?.irisId) {
    throw new Error("Invalid cursor");
  }
  return parsed;
};

export const parseReservationToken = (order: unknown): string | null => {
  if (!order || typeof order !== "object") {
    return null;
  }
  const lineItems = (order as { line_items?: Array<Record<string, unknown>> }).line_items;
  if (!Array.isArray(lineItems)) {
    return null;
  }
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
      if (name === "reservationToken" || name === "reservation_token") {
        const value = prop?.value?.toString().trim();
        if (value) {
          return value;
        }
      }
    }
  }
  return null;
};
