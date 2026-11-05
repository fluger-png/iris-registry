import crypto from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

export const loadStorefrontOrder = async (db: PrismaClient) => {
  try {
    const record = await db.collectionStorefrontOrder.findUnique({ where: { id: "global" } });
    return { available: true, ids: record?.collection_ids ?? [], revision: record?.revision ?? -1 };
  } catch (error) {
    // A pending additive migration must not break the existing storefront or partner pages.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      return { available: false, ids: [], revision: -1 };
    }
    throw error;
  }
};

export const sortStorefrontCollections = <T extends { id: string; name: string }>(collections: T[], ids: string[]): T[] => {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...collections].sort((a, b) =>
    (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
};

export const isCompleteCollectionOrder = (value: unknown, ids: string[]): value is string[] =>
  Array.isArray(value) && value.length === ids.length && value.every((id) => typeof id === "string" && ids.includes(id)) &&
  new Set(value).size === ids.length;

export const adminCollectionsCsrf = (secret: string, issuedAt: number) =>
  `${issuedAt}.${crypto.createHmac("sha256", secret).update(`admin-collections:${issuedAt}`).digest("hex")}`;

export const validAdminCollectionsCsrf = (value: unknown, secret: string): boolean => {
  if (typeof value !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(value)) return false;
  const issuedAt = Number(value.split(".")[0]);
  const age = Date.now() - issuedAt;
  if (age < 0 || age > 8 * 60 * 60 * 1000) return false;
  const expected = adminCollectionsCsrf(secret, issuedAt);
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
};
