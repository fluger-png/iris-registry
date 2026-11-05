import { describe, expect, it } from "vitest";
import { adminCollectionsCsrf, validAdminCollectionsCsrf, isCompleteCollectionOrder, sortStorefrontCollections } from "../src/storefront-collections.js";

describe("global collection ordering", () => {
  const collections = [{ id: "iris", name: "IRIS" }, { id: "a", name: "Ararat" }, { id: "okg", name: "The Art of Adornment" }];
  it("honors every saved position, including moving the core collection last", () => {
    expect(sortStorefrontCollections(collections, ["okg", "a", "iris"]).map((c) => c.id)).toEqual(["okg", "a", "iris"]);
    expect(collections[0].id).toBe("iris");
  });
  it("appends new collections alphabetically and ignores deleted IDs", () => {
    expect(sortStorefrontCollections(collections, ["deleted", "okg"]).map((c) => c.id)).toEqual(["okg", "a", "iris"]);
  });
  it("requires each current collection exactly once", () => {
    expect(isCompleteCollectionOrder(["okg", "iris", "a"], collections.map((c) => c.id))).toBe(true);
    for (const value of [["iris", "iris", "okg"], ["iris"], ["iris", "a", "foreign"], "iris", null, ["iris", "a", 1]]) {
      expect(isCompleteCollectionOrder(value, collections.map((c) => c.id))).toBe(false);
    }
  });
  it("validates signed, expiring admin CSRF tokens", () => {
    const now = Date.now();
    expect(validAdminCollectionsCsrf(adminCollectionsCsrf("secret", now), "secret")).toBe(true);
    for (const token of [adminCollectionsCsrf("other", now), adminCollectionsCsrf("secret", now - 9 * 3600000),
      adminCollectionsCsrf("secret", now + 60000), "invalid", null]) expect(validAdminCollectionsCsrf(token, "secret")).toBe(false);
  });
});
