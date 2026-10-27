import crypto from "node:crypto";
import { Collection, CollectionPresentation, Prisma, PrismaClient } from "@prisma/client";
import { collectionPricing, CollectionPriceState } from "./shopify-product-pricing.js";
import { collectionArtworkId } from "./collaborator-access.js";

export const COLLECTION_DESCRIPTION_MAX = 5000;
export const COLLECTION_NAME_MAX = 120;

export type CollectionPresentationView = {
  record: CollectionPresentation | null;
  available: boolean;
};

export const loadCollectionPresentation = async (db: PrismaClient, collectionId: string): Promise<CollectionPresentationView> => {
  try {
    return { record: await db.collectionPresentation.findUnique({ where: { collection_id: collectionId } }), available: true };
  } catch (error) {
    // Presentation is optional during rolling deployment; canonical collection data remains intact.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      return { record: null, available: false };
    }
    throw error;
  }
};

export const collectionCsrf = (sessionHash: string, collectionId: string) =>
  crypto.createHmac("sha256", sessionHash).update(`collection-presentation:${collectionId}`).digest("hex");

export const validCollectionCsrf = (value: unknown, sessionHash: string, collectionId: string) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
  crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(collectionCsrf(sessionHash, collectionId), "hex"));

export type CollectionProductView = { priceCents: number; currency: string; imageUrl: string | null };
const productCache = new Map<string, { value: CollectionProductView; expires: number }>();

export const clearCollectionProductCache = (handle: string | null) => { if (handle) productCache.delete(handle); };

export const loadCollectionProduct = async (handle: string | null): Promise<CollectionProductView | null> => {
  if (!handle || !/^[a-z0-9-]+$/.test(handle)) return null;
  const cached = productCache.get(handle);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    // Only canonical product handles from our database reach this fixed storefront origin.
    const response = await fetch(`https://irisnyc.store/products/${handle}.js`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return null;
    const data = await response.json() as { price?: unknown; featured_image?: unknown };
    if (typeof data.price !== "number" || !Number.isSafeInteger(data.price) || data.price < 0) return null;
    const image = typeof data.featured_image === "string" ? data.featured_image : null;
    const imageUrl = image?.startsWith("//cdn.shopify.com/") ? `https:${image}` : image?.startsWith("https://cdn.shopify.com/") ? image : null;
    const value = { priceCents: data.price, currency: "USD", imageUrl };
    productCache.set(handle, { value, expires: Date.now() + 60_000 });
    return value;
  } catch { return null; }
};

export type PartnerCollectionView = {
  collection: Collection;
  presentation: CollectionPresentationView;
  product: CollectionProductView | null;
  priceState: CollectionPriceState;
  purchased: number;
  activated: number;
  averageWeight: number | null;
  weighed: number;
};

export const purchasedArtworkWhere = (collectionId: string | null): Prisma.ArtworkWhereInput => ({
  collection_id: collectionId,
  assigned_order_id: { not: null },
  status: { in: ["assigned", "activated"] }
});

export const loadPublicCollectionBrand = async (db: PrismaClient, collection: Pick<Collection, "id" | "artist_name">) => {
  const artistName = collection.artist_name?.trim() || null;
  try {
    const partners = await db.collaboratorUser.findMany({
      where: { status: "active", OR: [{ collection_id: collection.id }, { collection_access: { some: { collection_id: collection.id } } }] },
      select: { full_name: true, profile: { select: { avatar_url: true } } }
    });
    const matches = artistName ? partners.filter((partner) => partner.full_name.trim().toLowerCase() === artistName.toLowerCase()) : [];
    // Do not attribute a collection to an arbitrary account when multiple partners have access.
    const brand = matches.length === 1 ? matches[0] : partners.length === 1 ? partners[0] : null;
    return { name: brand?.full_name.trim() || artistName, avatarUrl: brand?.profile?.avatar_url ?? null };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") return { name: artistName, avatarUrl: null };
    throw error;
  }
};

export const loadPartnerCollection = async (db: PrismaClient, collection: Collection): Promise<PartnerCollectionView> => {
  const presentation = await loadCollectionPresentation(db, collection.id);
  const [storefrontProduct, priceState] = await Promise.all([
    loadCollectionProduct(collection.shopify_handle), collectionPricing.inspect(collection)
  ]);
  const product = priceState.ready
    ? { priceCents: priceState.priceCents, currency: priceState.currency, imageUrl: storefrontProduct?.imageUrl ?? null }
    : storefrontProduct;
  const works = await db.artwork.findMany({
    where: purchasedArtworkWhere(collectionArtworkId(collection)),
    select: { status: true, weight_grams: true }
  });
  const weights = works.map((work) => work.weight_grams).filter((weight): weight is number => weight !== null && Number.isFinite(weight) && weight > 0);
  return {
    collection, presentation, product, priceState, purchased: works.length,
    activated: works.filter((work) => work.status === "activated").length,
    averageWeight: weights.length ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length : null,
    weighed: weights.length
  };
};
