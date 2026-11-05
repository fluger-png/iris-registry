export const OKG_COLLECTION = {
  slug: "the-art-of-adornment",
  name: "THE ART OF ADORNMENT",
  artistName: "OKG Jewelry",
  editionSize: 100,
  productId: "15499616190557",
  launchesAt: "2026-11-20T00:00:00-05:00"
} as const;

type ProductIdentity = {
  collectionSlug?: string | null;
  productHandle?: string | null;
  productId?: string | null;
};

export const pendingCollectionRelease = (identity: ProductIdentity, now = Date.now()): string | null => {
  const matches = [identity.collectionSlug, identity.productHandle]
    .some((value) => value?.trim().toLowerCase() === OKG_COLLECTION.slug) ||
    identity.productId?.replace(/^gid:\/\/shopify\/Product\//, "") === OKG_COLLECTION.productId;
  return matches && now < Date.parse(OKG_COLLECTION.launchesAt) ? OKG_COLLECTION.launchesAt : null;
};

export const okgArtworkIds = () => Array.from({ length: OKG_COLLECTION.editionSize },
  (_, index) => `OKG${String(index + 1).padStart(3, "0")}`);
