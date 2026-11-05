import { CollectionProductMedia, Prisma, PrismaClient } from "@prisma/client";

export const COLLECTION_VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export type CollectionProductMediaView = { available: boolean; record: CollectionProductMedia | null };

export const loadCollectionProductMedia = async (db: PrismaClient, collectionId: string): Promise<CollectionProductMediaView> => {
  try {
    return { available: true, record: await db.collectionProductMedia.findUnique({ where: { collection_id: collectionId } }) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") return { available: false, record: null };
    throw error;
  }
};

export const isCollectionMp4 = (data: Buffer): boolean => {
  if (data.length < 24 || data.length > COLLECTION_VIDEO_MAX_BYTES || data.toString("ascii", 4, 8) !== "ftyp") return false;
  const size = data.readUInt32BE(0);
  if (size < 16 || size > data.length || size > 4096 || size % 4 !== 0) return false;
  const brands = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash"]);
  // ISO BMFF's ftyp box contains a major brand, minor version, then compatible brands.
  for (let offset = 8; offset + 4 <= size; offset += 4) {
    if (offset !== 12 && brands.has(data.toString("ascii", offset, offset + 4))) return true;
  }
  return false;
};
