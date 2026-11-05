import { describe, expect, it } from "vitest";
import { COLLECTION_VIDEO_MAX_BYTES, isCollectionMp4 } from "../src/collection-product-media.js";

describe("collection MP4 validation", () => {
  const header = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex");
  it("recognizes compatible MP4 brands, not names or caller-supplied MIME types", () => {
    expect(isCollectionMp4(header)).toBe(true);
    expect(isCollectionMp4(Buffer.from("not a movie named movie.mp4"))).toBe(false);
    const quicktime = Buffer.from(header); quicktime.write("qt  ", 8); quicktime.write("qt  ", 16); quicktime.write("qt  ", 20);
    expect(isCollectionMp4(quicktime)).toBe(false);
    const malformed = Buffer.from(header); malformed.writeUInt32BE(4000, 0);
    expect(isCollectionMp4(malformed)).toBe(false);
    expect(isCollectionMp4(Buffer.alloc(8))).toBe(false);
  });
  it("accepts the exact 30 MB limit and rejects larger files", () => {
    const exact = Buffer.alloc(COLLECTION_VIDEO_MAX_BYTES); header.copy(exact);
    expect(isCollectionMp4(exact)).toBe(true);
    const oversized = Buffer.alloc(COLLECTION_VIDEO_MAX_BYTES + 1); header.copy(oversized);
    expect(isCollectionMp4(oversized)).toBe(false);
  });
});
