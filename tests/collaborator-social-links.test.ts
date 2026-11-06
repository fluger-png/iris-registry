import { describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { loadCollaboratorSocialLinks, normalizePartnerLink } from "../src/collaborator-social-links.js";

describe("partner social links", () => {
  it("normalizes profile URLs and removes social tracking parameters", () => {
    expect(normalizePartnerLink(" instagram.com/gugoco/?igsh=abc ", "instagram")).toBe("https://www.instagram.com/gugoco/");
    expect(normalizePartnerLink("https://www.tiktok.com/@gugoco?lang=en#x", "tiktok")).toBe("https://www.tiktok.com/@gugoco");
    expect(normalizePartnerLink("gugoco.com/about?lang=en#contact", "website")).toBe("https://gugoco.com/about?lang=en#contact");
    expect(normalizePartnerLink("", "website")).toBeNull();
  });

  it("rejects scripts, spoofed domains, credentials, local addresses and non-profile paths", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://example.com", "https://user:password@example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://a.local", "https://example.com:8080", "https://exam ple.com", "https://example.com\\@evil.com"]) {
      expect(() => normalizePartnerLink(value, "website")).toThrow();
    }
    for (const value of ["https://instagram.com.evil.com/gugoco", "https://evil.com/gugoco", "https://instagram.com/p/123", "https://instagram.com/"]) {
      expect(() => normalizePartnerLink(value, "instagram")).toThrow();
    }
    expect(() => normalizePartnerLink("https://tiktok.com/@gugoco/video/123", "tiktok")).toThrow();
  });

  it("omits invalid stored links without exposing extra profile fields", async () => {
    const findUnique = vi.fn().mockResolvedValue({ website_url: "javascript:bad", instagram_url: "https://instagram.com/gugoco/", tiktok_url: null, secret: "private" });
    const db = { collaboratorSocialLinks: { findUnique } } as unknown as PrismaClient;
    expect(await loadCollaboratorSocialLinks(db, "partner")).toEqual({ available: true, links: { instagram: "https://www.instagram.com/gugoco/", website: null, tiktok: null } });
    expect(findUnique).toHaveBeenCalledWith({ where: { user_id: "partner" } });
  });

  it("tolerates a missing table but propagates unrelated database failures", async () => {
    const findUnique = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "5.22.0" }));
    const db = { collaboratorSocialLinks: { findUnique } } as unknown as PrismaClient;
    expect(await loadCollaboratorSocialLinks(db, "partner")).toEqual({ available: false, links: { instagram: null, website: null, tiktok: null } });
    findUnique.mockRejectedValue(new Error("unavailable"));
    await expect(loadCollaboratorSocialLinks(db, "partner")).rejects.toThrow("unavailable");
  });
});
