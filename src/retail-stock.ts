import crypto from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

export class RetailStockError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export const retailCsrf = (secret: string, serial: string) =>
  crypto.createHmac("sha256", secret).update(`retail-sale:v1:${serial}`).digest("hex");
export const validRetailCsrf = (value: unknown, secret: string, serial: string) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
  crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(retailCsrf(secret, serial), "hex"));

export const isMissingRetailSchema = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021";

export const retailSchemaReady = async (db: PrismaClient): Promise<boolean> => {
  try { await db.retailBatch.count(); return true; }
  catch (error) { if (isMissingRetailSchema(error)) return false; throw error; }
};

export const loadRetailSoldIds = async (db: PrismaClient, collectionId: string | null): Promise<string[]> => {
  if (!collectionId) return [];
  try {
    return (await db.retailBatchItem.findMany({
      where: { sold_at: { not: null }, batch: { collection_id: collectionId } }, select: { iris_id: true }
    })).map((item) => item.iris_id);
  } catch (error) { if (isMissingRetailSchema(error)) return []; throw error; }
};

export type RetailBatchRequest = {
  reference: string; collectionId: string; retailer: string; quantity: number; actor: string;
};

export const validateRetailBatchRequest = (request: RetailBatchRequest) => {
  if (!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(request.reference) || !request.collectionId ||
      !request.retailer.trim() || request.retailer.length > 120 || !request.actor.trim() ||
      !Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > 1000) {
    throw new RetailStockError("Invalid batch reference, collection, retailer or quantity.", 400);
  }
};

// Lock the selected artworks, just as online allocation does. A stable reference makes retries idempotent.
export const createRetailBatch = async (db: PrismaClient, request: RetailBatchRequest,
  beforeWrite?: (snapshot: unknown) => Promise<void>) => {
  validateRetailBatchRequest(request);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`retail-batch:${request.reference}`}, 0))`;
    const existing = await tx.retailBatch.findUnique({ where: { id: request.reference }, include: { items: true } });
    if (existing) {
      if (existing.collection_id !== request.collectionId || existing.retailer !== request.retailer || existing.items.length !== request.quantity) {
        throw new RetailStockError("Batch reference already exists with different settings. Nothing changed.");
      }
      return { batch: existing, created: false };
    }
    const collection = await tx.collection.findUnique({ where: { id: request.collectionId } });
    if (!collection) throw new RetailStockError("Collection not found.", 404);
    const selected = await tx.$queryRaw<Array<{ iris_id: string }>>`
      SELECT a."iris_id" FROM "Artwork" a
      WHERE a."collection_id" = ${request.collectionId} AND a."status" = 'available'
        AND a."assigned_order_id" IS NULL AND a."assigned_customer_email" IS NULL
        AND a."owner_email" IS NULL AND a."activated_at" IS NULL
        AND a."pin_code" IS NULL AND a."activation_token" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r."iris_id" = a."iris_id" AND r."status" = 'active')
        AND NOT EXISTS (SELECT 1 FROM "RetailBatchItem" i WHERE i."iris_id" = a."iris_id")
      ORDER BY random() LIMIT ${request.quantity} FOR UPDATE OF a SKIP LOCKED
    `;
    if (selected.length !== request.quantity) {
      throw new RetailStockError(`Only ${selected.length} eligible, unlocked artworks found. No partial batch created.`);
    }
    const ids = selected.map((item) => item.iris_id);
    const originals = await tx.artwork.findMany({ where: { iris_id: { in: ids } } });
    if (beforeWrite) await beforeWrite({ reference: request.reference, collection, artworks: originals });
    const batch = await tx.retailBatch.create({ data: {
      id: request.reference, collection_id: request.collectionId, retailer: request.retailer,
      created_by: request.actor, items: { create: ids.map((iris_id) => ({ iris_id })) }
    }, include: { items: true } });
    for (const irisId of ids) {
      const pin = crypto.randomInt(100000, 1000000).toString();
      const changed = await tx.artwork.updateMany({ where: { iris_id: irisId, status: "available", owner_email: null,
        assigned_order_id: null, assigned_customer_email: null, activated_at: null, pin_code: null, activation_token: null },
      data: { status: "retail_stock", pin_code: pin, pin_last4: pin.slice(-4),
        activation_token: crypto.randomBytes(16).toString("hex"), pin_attempts: 0, pin_locked_until: null } });
      if (changed.count !== 1) throw new RetailStockError("Artwork availability changed. The entire batch was rolled back.");
      await tx.event.create({ data: { iris_id: irisId, type: "retail_allocated", actor: request.actor,
        payload_json: { batch_id: request.reference, retailer: request.retailer, channel: "retail" } } });
    }
    return { batch, created: true };
  }, { maxWait: 5000, timeout: 30000 });
};

export const markRetailSold = async (db: PrismaClient, irisId: string, collectionIds: string[], actor: string) =>
  db.$transaction(async (tx) => {
    const item = await tx.retailBatchItem.findFirst({
      where: { iris_id: irisId, batch: { collection_id: { in: collectionIds } } }
    });
    if (!item) throw new RetailStockError("Retail artwork not found.", 404);
    if (item.sold_at) return { alreadySold: true };
    const changed = await tx.artwork.updateMany({
      where: { iris_id: irisId, status: "retail_stock", owner_email: null, activated_at: null, assigned_order_id: null },
      data: { status: "assigned" }
    });
    if (changed.count !== 1) throw new RetailStockError("The artwork status changed. Reload before trying again.");
    const soldAt = new Date();
    const sale = await tx.retailBatchItem.updateMany({ where: { iris_id: irisId, sold_at: null }, data: { sold_at: soldAt, sold_by: actor } });
    if (sale.count !== 1) throw new RetailStockError("The sale was already recorded. Reload to confirm.");
    await tx.event.create({ data: { iris_id: irisId, type: "retail_sold", actor,
      payload_json: { batch_id: item.batch_id, channel: "retail", sold_at: soldAt.toISOString() } } });
    return { alreadySold: false };
  });

export const loadRetailStock = (db: PrismaClient, collectionIds?: string[]) => db.retailBatch.findMany({
  where: collectionIds ? { collection_id: { in: collectionIds } } : {},
  orderBy: [{ created_at: "desc" }, { id: "asc" }],
  include: { collection: { select: { name: true } }, items: {
    orderBy: { iris_id: "asc" }, include: { artwork: { select: {
      iris_id: true, status: true, image_url: true, activated_at: true, owner_email: true
    } } }
  } }
});
export type RetailStockView = Awaited<ReturnType<typeof loadRetailStock>>;

export const retailBatchCsv = (items: Array<{ iris_id: string; pin_code: string | null; activation_token: string | null }>, origin: string) => {
  const cell = (value: string) => `"${(/^[=+@\-\t\r]/.test(value) ? "'" : "") + value.replace(/"/g, '""')}"`;
  return ["IRIS ID,PIN,NFC URL", ...items.map((item) => {
    if (!item.pin_code || !item.activation_token) throw new RetailStockError("Missing PIN or NFC token. Export stopped.");
    return [item.iris_id, item.pin_code, `${origin.replace(/\/$/, "")}/pages/activate?token=${encodeURIComponent(item.activation_token)}`].map(cell).join(",");
  })].join("\r\n");
};
