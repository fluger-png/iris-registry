import { describe, expect, it } from "vitest";
import { OKG_COLLECTION, okgArtworkIds, pendingCollectionRelease } from "../src/collection-release.js";

describe("OKG launch", () => {
  const launch = Date.parse("2026-11-20T05:00:00Z");
  it("opens at midnight New York time, including the exact boundary", () => {
    expect(Date.parse(OKG_COLLECTION.launchesAt)).toBe(launch);
    expect(pendingCollectionRelease({ productHandle: OKG_COLLECTION.slug }, launch - 1)).toBe(OKG_COLLECTION.launchesAt);
    expect(pendingCollectionRelease({ productHandle: OKG_COLLECTION.slug }, launch)).toBeNull();
  });
  it("recognizes Shopify IDs and does not depend on a client-supplied handle", () => {
    for (const productId of [OKG_COLLECTION.productId, `gid://shopify/Product/${OKG_COLLECTION.productId}`]) {
      expect(pendingCollectionRelease({ productId }, launch - 1)).toBe(OKG_COLLECTION.launchesAt);
    }
    expect(pendingCollectionRelease({ collectionSlug: OKG_COLLECTION.slug }, launch - 1)).not.toBeNull();
  });
  it("does not restrict existing collections", () => {
    for (const productHandle of ["iris-the-unseen-edition", "ararat-heart", "sayat-nova"]) {
      expect(pendingCollectionRelease({ productHandle }, launch - 1)).toBeNull();
    }
  });
  it("provisions exactly 100 unique compact serials", () => {
    const ids = okgArtworkIds();
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(ids[0]).toBe("OKG001");
    expect(ids[99]).toBe("OKG100");
    expect(ids.every((id) => /^OKG\d{3}$/.test(id))).toBe(true);
  });
});
