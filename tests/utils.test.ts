import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { verifyShopifyHmac } from "../src/utils.js";

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
