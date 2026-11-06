import { describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { loadCollaboratorSocialLinks, normalizePartnerLink, PARTNER_LINK_KINDS } from "../src/collaborator-social-links.js";

describe("partner social links", () => {
  it("normalizes profile URLs and removes social tracking parameters", () => {
    expect(normalizePartnerLink(" instagram.com/gugoco/?igsh=abc ", "instagram")).toBe("https://www.instagram.com/gugoco/");
    expect(normalizePartnerLink("https://www.tiktok.com/@gugoco?lang=en#x", "tiktok")).toBe("https://www.tiktok.com/@gugoco");
    expect(normalizePartnerLink("gugoco.com/about?lang=en#contact", "website")).toBe("https://gugoco.com/about?lang=en#contact");
    expect(normalizePartnerLink("", "website")).toBeNull();
    expect(normalizePartnerLink("https://twitter.com/your_brand/?ref=share", "x")).toBe("https://x.com/your_brand");
    expect(normalizePartnerLink("https://www.x.com/YourBrand", "x")).toBe("https://x.com/YourBrand");
    expect(PARTNER_LINK_KINDS).toEqual(["website", "instagram", "tiktok", "x"]);
  });

  it("rejects scripts, spoofed domains, credentials, local addresses and non-profile paths", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://example.com", "https://user:password@example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://a.local", "https://example.com:8080", "https://exam ple.com", "https://example.com\\@evil.com"]) {
      expect(() => normalizePartnerLink(value, "website")).toThrow();
    }
    for (const value of ["https://instagram.com.evil.com/gugoco", "https://evil.com/gugoco", "https://instagram.com/p/123", "https://instagram.com/"]) {
      expect(() => normalizePartnerLink(value, "instagram")).toThrow();
    }
    expect(() => normalizePartnerLink("https://tiktok.com/@gugoco/video/123", "tiktok")).toThrow();
    for (const value of ["https://x.com.evil.com/user", "https://twitter.com@evil.com/user", "https://x.com/user/status/123", "https://x.com/username_that_is_too_long", "https://x.com/@user"]) {
      expect(() => normalizePartnerLink(value, "x")).toThrow();
    }
  });

  it("omits invalid stored links without exposing extra profile fields", async () => {
    const findUnique = vi.fn().mockResolvedValue({ website_url: "javascript:bad", instagram_url: "https://instagram.com/gugoco/", tiktok_url: null, secret: "private" });
    const db = { collaboratorSocialLinks: { findUnique } } as unknown as PrismaClient;
    expect(await loadCollaboratorSocialLinks(db, "partner")).toEqual({ available: true, xAvailable: true, links: { instagram: "https://www.instagram.com/gugoco/", website: null, tiktok: null, x: null } });
    expect(findUnique).toHaveBeenCalledWith({ where: { user_id: "partner" }, select: { website_url: true, instagram_url: true, tiktok_url: true, x_url: true } });
  });

  it("tolerates a missing table but propagates unrelated database failures", async () => {
    const findUnique = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "5.22.0" }));
    const db = { collaboratorSocialLinks: { findUnique } } as unknown as PrismaClient;
    expect(await loadCollaboratorSocialLinks(db, "partner")).toEqual({ available: false, xAvailable: false, links: { instagram: null, website: null, tiktok: null, x: null } });
    findUnique.mockRejectedValue(new Error("unavailable"));
    await expect(loadCollaboratorSocialLinks(db, "partner")).rejects.toThrow("unavailable");
  });

  it("preserves existing links if only the X column has not been migrated", async () => {
    const findUnique = vi.fn()
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("missing X column", { code: "P2022", clientVersion: "5.22.0" }))
      .mockResolvedValueOnce({ website_url: "https://gugoco.com/", instagram_url: "https://instagram.com/gugoco", tiktok_url: null });
    const db = { collaboratorSocialLinks: { findUnique } } as unknown as PrismaClient;
    expect(await loadCollaboratorSocialLinks(db, "partner")).toEqual({ available: true, xAvailable: false, links: { website: "https://gugoco.com/", instagram: "https://www.instagram.com/gugoco/", tiktok: null, x: null } });
    expect(findUnique).toHaveBeenLastCalledWith({ where: { user_id: "partner" }, select: { website_url: true, instagram_url: true, tiktok_url: true } });
  });
});
