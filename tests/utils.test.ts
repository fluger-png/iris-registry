import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { parseShopifyLineItems, verifyShopifyHmac } from "../src/utils.js";

describe("verifyShopifyHmac", () => {
  it("validates matching HMAC", () => {
    const secret = "shh";
    const payload = Buffer.from("{\"ok\":true}");
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("base64");

    expect(verifyShopifyHmac(payload, secret, hmac)).toBe(true);
  });

  it("rejects mismatched HMAC", () => {
    const secret = "shh";
    const payload = Buffer.from("{\"ok\":true}");

    expect(verifyShopifyHmac(payload, secret, "nope")).toBe(false);
  });
});

describe("parseShopifyLineItems", () => {
  it("extracts reservation, iris, and collection metadata from line item properties", () => {
    const parsed = parseShopifyLineItems({
      line_items: [
        {
          product_id: 123,
          quantity: 2,
          properties: [
            { name: "IRIS_ID", value: "IRIS-1001" },
            { name: "IRIS_RESERVATION_TOKEN", value: "token-1" },
            { name: "_IRIS_COLLECTION_SLUG", value: "iris-the-unseen-edition" },
            { name: "_IRIS_PRODUCT_HANDLE", value: "iris-the-unseen-edition" }
          ]
        }
      ]
    });

    expect(parsed).toEqual([
      {
        productId: "123",
        handle: "iris-the-unseen-edition",
        title: null,
        name: null,
        sku: null,
        variantTitle: null,
        quantity: 2,
        irisIds: ["IRIS-1001"],
        collectionSlugs: ["iris-the-unseen-edition"],
        reservationTokens: ["token-1"]
      }
    ]);
  });

  it("deduplicates repeated IRIS metadata", () => {
    const parsed = parseShopifyLineItems({
      line_items: [
        {
          product_id: "456",
          handle: "sayat-nova",
          properties: [
            { name: "iris-id", value: "SN-001" },
            { name: "_iris_id", value: "SN-001" },
            { name: "reservation_token", value: "token-2" },
            { name: "iris-reservation-token", value: "token-2" },
            { name: "collection-slug", value: "sayat-nova" },
            { name: "_iris_collection_slug", value: "sayat-nova" }
          ]
        }
      ]
    });

    expect(parsed[0]).toMatchObject({
      productId: "456",
      handle: "sayat-nova",
      title: null,
      name: null,
      sku: null,
      variantTitle: null,
      quantity: 1,
      irisIds: ["SN-001"],
      collectionSlugs: ["sayat-nova"],
      reservationTokens: ["token-2"]
    });
  });

  it("keeps product identity fields for sales channels that drop custom properties", () => {
    const parsed = parseShopifyLineItems({
      line_items: [
        {
          product_id: null,
          title: "IRIS - The Unseen Edition",
          name: "IRIS - The Unseen Edition - Default Title",
          sku: "IRIS-UNSEEN",
          variant_title: "Default Title",
          quantity: 1,
          properties: []
        }
      ]
    });

    expect(parsed[0]).toMatchObject({
      productId: null,
      handle: null,
      title: "IRIS - The Unseen Edition",
      name: "IRIS - The Unseen Edition - Default Title",
      sku: "IRIS-UNSEEN",
      variantTitle: "Default Title",
      quantity: 1,
      reservationTokens: []
    });
  });
});
