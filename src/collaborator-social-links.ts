import { isIP } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";

export const PARTNER_LINK_MAX_LENGTH = 2048;
export const PARTNER_LINK_KINDS = ["website", "instagram", "tiktok", "x"] as const;
export type PartnerLinkKind = typeof PARTNER_LINK_KINDS[number];
export type PartnerSocialLinks = Record<PartnerLinkKind, string | null>;
export const emptyPartnerSocialLinks = (): PartnerSocialLinks => ({ website: null, instagram: null, tiktok: null, x: null });

export const normalizePartnerLink = (value: string, kind: PartnerLinkKind): string | null => {
  const input = value.trim();
  if (!input) return null;
  const label = { website: "website", instagram: "Instagram", tiktok: "TikTok", x: "X" }[kind];
  const invalid = () => new Error(`Enter a valid HTTPS ${label}${kind === "website" ? "" : " profile"} URL.`);
  if (input.length > PARTNER_LINK_MAX_LENGTH || /[\s\\\u0000-\u001f\u007f]/.test(input)) throw invalid();
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw invalid();
  const host = url.hostname;
  if (isIP(host) || host.startsWith("[") || !host.includes(".") || /\.(?:local|localhost|internal)$/i.test(host) ||
    !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw invalid();
  if (kind !== "website") {
    if (kind === "x") {
      const match = url.pathname.match(/^\/([a-z\d_]{1,15})\/?$/i);
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host) || !match) throw invalid();
      return `https://x.com/${match[1]}`;
    }
    const domain = kind === "instagram" ? "instagram.com" : "tiktok.com";
    const path = kind === "instagram" ? /^\/([a-z\d._]+)\/?$/i : /^\/@([a-z\d._]+)\/?$/i;
    const match = url.pathname.match(path);
    if (![domain, `www.${domain}`].includes(host) || !match) throw invalid();
    return `https://www.${domain}/${kind === "tiktok" ? "@" : ""}${match[1]}${kind === "instagram" ? "/" : ""}`;
  }
  if (url.href.length > PARTNER_LINK_MAX_LENGTH) throw invalid();
  return url.href;
};

export const loadCollaboratorSocialLinks = async (db: PrismaClient, userId: string) => {
  try {
    const legacySelect = { website_url: true, instagram_url: true, tiktok_url: true } as const;
    let record: Partial<Record<`${PartnerLinkKind}_url`, string | null>> | null;
    let xAvailable = true;
    try {
      record = await db.collaboratorSocialLinks.findUnique({ where: { user_id: userId }, select: { ...legacySelect, x_url: true } });
    } catch (error) {
      // Preserve the three existing links while the new X column rolls out.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2022") throw error;
      record = await db.collaboratorSocialLinks.findUnique({ where: { user_id: userId }, select: legacySelect });
      xAvailable = false;
    }
    const links = emptyPartnerSocialLinks();
    // Validate stored values too, so a bad imported URL never reaches the storefront.
    for (const kind of PARTNER_LINK_KINDS) {
      try { links[kind] = normalizePartnerLink(record?.[`${kind}_url`] ?? "", kind); } catch { /* Omit invalid links. */ }
    }
    return { links, available: true, xAvailable };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      return { links: emptyPartnerSocialLinks(), available: false, xAvailable: false };
    }
    throw error;
  }
};
