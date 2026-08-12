import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Prisma, ArtworkStatus, CollaboratorStatus } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import path from "node:path";
import querystring from "node:querystring";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { decodeCursor, encodeCursor, parseShopifyLineItems, verifyShopifyHmac } from "./utils.js";
import { computeLeaf, verifyMerkleProof } from "./rarity.js";
import fs from "node:fs";

const MAX_PAGE_SIZE = 100;
const GOLD_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const TROY_OUNCE_GRAMS = 31.1034768;
let goldCache: { price: number; ts: number } | null = null;

const loadLiveGoldPriceUsdG = async (): Promise<{ price: number; updatedAt: Date }> => {
  const now = Date.now();
  if (goldCache && now - goldCache.ts < GOLD_CACHE_TTL_MS) {
    return { price: goldCache.price, updatedAt: new Date(goldCache.ts) };
  }

  let primaryError: unknown = null;
  if (env.goldApiKey) {
    try {
      const res = await fetch("https://www.goldapi.io/api/XAU/USD", {
        headers: {
          "x-access-token": env.goldApiKey,
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) {
        throw new Error(`goldapi_bad_status_${res.status}`);
      }

      const data = (await res.json()) as { price_gram_24k?: number | string | null; price?: number | string | null };
      let perGram = data.price_gram_24k == null ? Number.NaN : Number(data.price_gram_24k);
      if ((!Number.isFinite(perGram) || perGram <= 0) && data.price != null) {
        perGram = Number(data.price) / TROY_OUNCE_GRAMS;
      }
      if (!Number.isFinite(perGram) || perGram <= 0) {
        throw new Error("goldapi_missing_price");
      }

      goldCache = { price: perGram, ts: now };
      return { price: perGram, updatedAt: new Date(now) };
    } catch (error) {
      primaryError = error;
    }
  }

  try {
    const fallbackRes = await fetch("https://api.gold-api.com/price/XAU", {
      headers: { Accept: "application/json" }
    });
    if (!fallbackRes.ok) {
      throw new Error(`gold_fallback_bad_status_${fallbackRes.status}`);
    }

    const fallbackData = (await fallbackRes.json()) as { price?: number | string | null; updatedAt?: string | null };
    const ouncePrice = fallbackData.price == null ? Number.NaN : Number(fallbackData.price);
    const perGram = ouncePrice / TROY_OUNCE_GRAMS;
    if (!Number.isFinite(perGram) || perGram <= 0) {
      throw new Error("gold_fallback_missing_price");
    }

    const updatedAt = parseDateValue(fallbackData.updatedAt) ?? new Date(now);
    goldCache = { price: perGram, ts: now };
    return { price: perGram, updatedAt };
  } catch (fallbackError) {
    throw primaryError ?? fallbackError;
  }
};

const parseLimit = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
};

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  }
});

const sanitizeIrisId = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
const normalizeIrisIdInput = (value: string): string => {
  const clean = sanitizeIrisId(value);
  return /^\d+$/.test(clean) ? `IRIS-${clean.padStart(4, "0").slice(-4)}` : clean;
};
const normalizeCollectionSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const generateActivationToken = (): string => crypto.randomBytes(16).toString("hex");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: env.adminTimezone,
  year: "2-digit",
  month: "2-digit",
  day: "2-digit"
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: env.adminTimezone,
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const formatDate = (value: Date): string => {
  const parts = dateFormatter.formatToParts(new Date(value));
  const mm = parts.find((p) => p.type === "month")?.value ?? "00";
  const dd = parts.find((p) => p.type === "day")?.value ?? "00";
  const yy = parts.find((p) => p.type === "year")?.value ?? "00";
  return `${mm}.${dd}.${yy}`;
};

const formatDateTime = (value: Date): string => {
  const parts = dateTimeFormatter.formatToParts(new Date(value));
  const mm = parts.find((p) => p.type === "month")?.value ?? "00";
  const dd = parts.find((p) => p.type === "day")?.value ?? "00";
  const yy = parts.find((p) => p.type === "year")?.value ?? "00";
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const min = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${mm}.${dd}.${yy} ${hh}:${min}`;
};

const parseDateValue = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const extractShopifyOrderDate = (order: Record<string, unknown>): Date | null =>
  parseDateValue(order.created_at) ?? parseDateValue(order.processed_at) ?? parseDateValue(order.updated_at);

const extractAssignedEventOrderDate = (event: {
  created_at: Date;
  payload_json: Prisma.JsonValue;
}): Date => {
  const payload =
    event.payload_json && typeof event.payload_json === "object" && !Array.isArray(event.payload_json)
      ? (event.payload_json as Record<string, unknown>)
      : {};
  return (
    parseDateValue(payload.order_created_at) ??
    parseDateValue(payload.shopify_order_created_at) ??
    parseDateValue(payload.order_date) ??
    event.created_at
  );
};

const publicProofHtmlTemplate = (() => {
  const distPath = path.join(process.cwd(), "dist", "verify.html");
  const srcPath = path.join(process.cwd(), "src", "verify.html");
  if (fs.existsSync(distPath)) {
    return fs.readFileSync(distPath, "utf8");
  }
  if (fs.existsSync(srcPath)) {
    return fs.readFileSync(srcPath, "utf8");
  }
  console.warn("verify.html not found in dist/ or src/");
  return "<!doctype html><html><head><meta charset=\"utf-8\" /><title>IRIS Proof</title></head><body>Proof page unavailable.</body></html>";
})();

const requireAdmin = async (req: any, reply: any): Promise<boolean> => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="IRIS Admin"').send("Unauthorized");
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user !== env.adminBasicUser || pass !== env.adminBasicPass) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="IRIS Admin"').send("Unauthorized");
    return false;
  }
  return true;
};

const PARTNER_SESSION_COOKIE = "iris_partner_session";
const IRIS_ACCOUNT_SESSION_COOKIE = "iris_account_session";
const PARTNER_PASSWORD_KEYLEN = 64;
const IRIS_ACCOUNT_SESSION_DAYS = 30;
const IRIS_LOGIN_CODE_TTL_MINUTES = 10;
const IRIS_LOGIN_CODE_MAX_ATTEMPTS = 5;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const readSingleValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
};

const normalizeEmail = (value: unknown): string => readSingleValue(value).trim().toLowerCase();
const isValidEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const parseCookieHeader = (header: string | undefined): Record<string, string> => {
  if (!header) {
    return {};
  }
  return header.split(";").reduce<Record<string, string>>((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) {
      return acc;
    }
    acc[name] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
};

const createOpaqueToken = (): string => crypto.randomBytes(32).toString("base64url");
const hashOpaqueToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");
const normalizeTransferCode = (value: string): string => value.trim().replace(/\s+/g, "").toUpperCase();
const hashTransferCode = (code: string): string =>
  crypto.createHash("sha256").update(normalizeTransferCode(code)).digest("hex");
const generateTransferCode = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const publicTransferErrorReason = (error: unknown): string => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `prisma_${error.code}`;
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    return "prisma_validation";
  }
  if (error instanceof Error) {
    return error.name || "error";
  }
  return "unknown";
};

const TRANSFER_TTL_DAYS = 14;
const TRANSFER_MAX_ATTEMPTS = 5;
const TRANSFER_LOCK_MINUTES = 60;
const TRANSFER_EMAIL_TIMEOUT_MS = 8_000;

const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, PARTNER_PASSWORD_KEYLEN);
  return `${salt.toString("hex")}:${digest.toString("hex")}`;
};

const verifyPassword = (password: string, encoded: string | null): boolean => {
  if (!encoded) {
    return false;
  }
  const [saltHex, digestHex] = encoded.split(":");
  if (!saltHex || !digestHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(digestHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
};

const buildCookie = (name: string, value: string, expiresAt: Date): string => {
  const isSecure =
    env.partnerPortalBaseUrl.startsWith("https://") || env.baseUrl.startsWith("https://");
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    isSecure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
};

const clearCookie = (name: string): string => {
  const isSecure =
    env.partnerPortalBaseUrl.startsWith("https://") || env.baseUrl.startsWith("https://");
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
    isSecure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
};

const createPartnerInviteUrl = (rawToken: string): string =>
  `${env.partnerPortalBaseUrl.replace(/\/$/, "")}/partner/invite/${rawToken}`;

const setPartnerSessionCookie = (reply: any, rawToken: string, expiresAt: Date): void => {
  reply.header("Set-Cookie", buildCookie(PARTNER_SESSION_COOKIE, rawToken, expiresAt));
};

const clearPartnerSessionCookie = (reply: any): void => {
  reply.header("Set-Cookie", clearCookie(PARTNER_SESSION_COOKIE));
};

const setIrisAccountSessionCookie = (reply: any, rawToken: string, expiresAt: Date): void => {
  reply.header("Set-Cookie", buildCookie(IRIS_ACCOUNT_SESSION_COOKIE, rawToken, expiresAt));
};

const clearIrisAccountSessionCookie = (reply: any): void => {
  reply.header("Set-Cookie", clearCookie(IRIS_ACCOUNT_SESSION_COOKIE));
};

const hashLoginCode = (email: string, code: string): string =>
  crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${code.trim().replace(/\s+/g, "")}`)
    .digest("hex");

const generateLoginCode = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const normalizeUsername = (value: unknown): string =>
  readSingleValue(value)
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");

const isValidUsername = (value: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/.test(value);

const IRIS_ACCOUNT_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  display_name: true,
  profile_public: true
} as const;

const loadIrisAccountAvatarIrisId = async (userId: string, email: string): Promise<string | null> => {
  const events = await prisma.event.findMany({
    where: {
      type: "iris_account_avatar_set",
      actor: normalizeEmail(email)
    },
    orderBy: { created_at: "desc" },
    select: {
      iris_id: true,
      payload_json: true
    },
    take: 20
  });

  for (const event of events) {
    const payload = event.payload_json;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { user_id?: unknown }).user_id === userId) {
      return event.iris_id;
    }
  }

  return null;
};

const withIrisAccountAvatar = async (user: {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  profile_public: boolean;
}): Promise<IrisAccountUserView> => ({
  ...user,
  avatar_iris_id: await loadIrisAccountAvatarIrisId(user.id, user.email)
});

const usernameSeedFromEmail = (email: string): string => {
  const localPart = normalizeEmail(email).split("@")[0] ?? "iris";
  const seed = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (isValidUsername(seed)) {
    return seed;
  }
  return `iris-${crypto.randomInt(1000, 9999)}`;
};

const createUniqueIrisUsername = async (email: string): Promise<string> => {
  const seed = usernameSeedFromEmail(email);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomInt(1000, 9999)}`;
    const candidate = `${seed.slice(0, 24 - suffix.length)}${suffix}`;
    if (!isValidUsername(candidate)) {
      continue;
    }
    const existing = await prisma.irisUser.findUnique({
      where: { username: candidate },
      select: { id: true }
    });
    if (!existing) {
      return candidate;
    }
  }
  return `iris-${crypto.randomUUID().slice(0, 8)}`;
};

const findOrCreateIrisUserByEmail = async (email: string) => {
  const normalizedEmail = normalizeEmail(email);
  const existing = await prisma.irisUser.findUnique({
    where: { email: normalizedEmail },
    select: IRIS_ACCOUNT_USER_SELECT
  });
  if (existing) {
    return withIrisAccountAvatar(existing);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = await createUniqueIrisUsername(normalizedEmail);
    try {
      return await prisma.irisUser.create({
        data: {
          email: normalizedEmail,
          username
        },
        select: IRIS_ACCOUNT_USER_SELECT
      }).then(withIrisAccountAvatar);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await prisma.irisUser.findUnique({
          where: { email: normalizedEmail },
          select: IRIS_ACCOUNT_USER_SELECT
        });
        if (raced) {
          return withIrisAccountAvatar(raced);
        }
        continue;
      }
      throw error;
    }
  }

  throw new Error("iris_user_create_failed");
};

const createIrisAccountSession = async (userId: string) => {
  const rawToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + IRIS_ACCOUNT_SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.irisAccountSession.create({
    data: {
      user_id: userId,
      token_hash: hashOpaqueToken(rawToken),
      expires_at: expiresAt,
      last_seen_at: new Date()
    }
  });

  return { rawToken, expiresAt };
};

const getIrisAccountAuth = async (req: any, fallbackRawToken?: string) => {
  const query = (req.query as { session?: unknown } | null) ?? {};
  const queryRawToken = readSingleValue(query.session).trim();
  const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
  const rawToken = fallbackRawToken?.trim() || queryRawToken || cookies[IRIS_ACCOUNT_SESSION_COOKIE];
  if (!rawToken) {
    return null;
  }

  const session = await prisma.irisAccountSession.findFirst({
    where: {
      token_hash: hashOpaqueToken(rawToken),
      expires_at: { gt: new Date() }
    },
    include: {
      user: {
        select: IRIS_ACCOUNT_USER_SELECT
      }
    }
  });

  if (!session) {
    return null;
  }

  return { rawToken, session, user: await withIrisAccountAvatar(session.user) };
};

const loadArchiveLikeState = async (
  irisIds: string[],
  userId: string | null
): Promise<{ enabled: boolean; counts: Map<string, number>; liked: Set<string> }> => {
  if (!userId || irisIds.length === 0) {
    return { enabled: false, counts: new Map(), liked: new Set() };
  }

  try {
    const [counts, likedRows] = await Promise.all([
      prisma.artworkLike.groupBy({
        by: ["iris_id"],
        where: { iris_id: { in: irisIds } },
        _count: { _all: true }
      }),
      prisma.artworkLike.findMany({
        where: {
          iris_id: { in: irisIds },
          user_id: userId
        },
        select: { iris_id: true }
      })
    ]);

    return {
      enabled: true,
      counts: new Map(counts.map((item) => [item.iris_id, item._count._all])),
      liked: new Set(likedRows.map((item) => item.iris_id))
    };
  } catch {
    return { enabled: false, counts: new Map(), liked: new Set() };
  }
};

const countArtworkLikes = async (irisId: string): Promise<number> => {
  try {
    return await prisma.artworkLike.count({ where: { iris_id: irisId } });
  } catch {
    return 0;
  }
};

const sendCollaboratorInviteEmailBestEffort = async (params: {
  email: string;
  fullName: string;
  collectionName: string;
  inviteLink: string;
}): Promise<{ sent: boolean; reason: string }> => {
  if (!env.resendApiKey || !env.resendFromEmail) {
    return { sent: false, reason: "email_not_configured" };
  }

  const subject = `You’re invited to the IRIS Partner Portal`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#0A0A09;color:#F5F1E8;padding:32px;">
      <div style="max-width:560px;margin:0 auto;background:#111111;border:1px solid #2A2722;padding:32px;">
        <div style="font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#C9A84C;margin-bottom:16px;">IRIS Partner Portal</div>
        <h1 style="margin:0 0 18px;font-size:34px;line-height:1.05;font-weight:600;color:#F5F1E8;">Welcome, ${escapeHtml(params.fullName)}.</h1>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.7;color:#D0C7B7;">
          Your collaborator account for <strong style="color:#F5F1E8;">${escapeHtml(params.collectionName)}</strong> is ready.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#D0C7B7;">
          Use the button below to create your password and access the IRIS Partner Portal.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${params.inviteLink}" style="display:inline-block;padding:14px 20px;background:#C9A84C;color:#111111;text-decoration:none;font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-size:12px;">Create Password</a>
        </p>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#9F9686;">If the button doesn't work, copy this link:</p>
        <p style="margin:0;font-size:13px;line-height:1.7;word-break:break-all;color:#F5F1E8;">${params.inviteLink}</p>
      </div>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.resendFromEmail,
      to: [params.email],
      subject,
      html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    return { sent: false, reason: `email_error:${text}` };
  }

  return { sent: true, reason: "sent" };
};

const sendOwnershipTransferEmailBestEffort = async (params: {
  toEmail: string;
  fromEmail: string;
  displayIrisId: string;
  transferCode: string;
  expiresAt: Date;
  imageUrl: string | null;
  weightGrams: number | null;
  rarityCode: string | null;
  activatedAt: Date | null;
}): Promise<{ sent: boolean; reason: string }> => {
  if (!env.resendApiKey || !env.resendFromEmail) {
    return { sent: false, reason: "email_not_configured" };
  }

  const expiresLabel = params.expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  const activatedAtLabel = params.activatedAt
    ? params.activatedAt.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
      })
    : "-";
  const weightLabel =
    typeof params.weightGrams === "number" && Number.isFinite(params.weightGrams)
      ? `${params.weightGrams.toFixed(2)} g`
      : "-";
  const rarityLabel = params.rarityCode || "-";
  const imageBlock = params.imageUrl
    ? `<img src="${escapeHtml(params.imageUrl)}" alt="${escapeHtml(
        params.displayIrisId
      )}" style="display:block;width:100%;height:auto;border:1px solid #E5E7EB;background:#F8FAFC;" />`
    : `<div style="height:260px;border:1px solid #E5E7EB;background:#F8FAFC;display:flex;align-items:center;justify-content:center;color:#6B7280;font-size:14px;">IRIS image</div>`;
  const detailRows = [
    ["Weight", weightLabel],
    ["Rarity", rarityLabel],
    ["First activation", activatedAtLabel]
  ]
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:13px 0;border-top:1px solid #E5E7EB;color:#6B7280;font-size:11px;letter-spacing:.16em;text-transform:uppercase;">${escapeHtml(label)}</td>
          <td style="padding:13px 0;border-top:1px solid #E5E7EB;color:#111827;font-size:15px;font-weight:700;text-align:right;">${escapeHtml(value)}</td>
        </tr>
      `
    )
    .join("");
  const subject = `Transfer code for ${params.displayIrisId}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#F3F4F8;color:#111827;padding:32px;">
      <div style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:22px;padding:28px;box-shadow:0 18px 48px rgba(15,23,42,.08);">
        <div style="font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#6B7280;margin-bottom:14px;">IRIS Ownership Transfer</div>
        <h1 style="margin:0 0 18px;font-size:34px;line-height:1.05;font-weight:700;color:#111827;">${escapeHtml(params.displayIrisId)} is ready to be claimed.</h1>
        <div style="margin:0 0 22px;">
          ${imageBlock}
        </div>
        <p style="margin:0 0 12px;font-size:16px;line-height:1.7;color:#4B5563;">
          ${escapeHtml(params.fromEmail)} has started an ownership transfer to this email address.
        </p>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.7;color:#4B5563;">
          To complete the transfer, hold the physical IRIS piece, scan the NFC tag, and enter the transfer code below on the IRIS activation page.
        </p>
        <div style="margin:24px 0;padding:20px 22px;border:1px solid #111827;background:#FFFFFF;text-align:center;">
          <div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#6B7280;margin-bottom:10px;">Transfer Code</div>
          <div style="font-size:32px;letter-spacing:.28em;font-weight:700;color:#111827;">${escapeHtml(params.transferCode)}</div>
        </div>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 22px;">
          <tbody>
            ${detailRows}
          </tbody>
        </table>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#6B7280;">
          The NFC link on the artwork does not change. This code expires on ${escapeHtml(expiresLabel)}.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6B7280;">
          If you were not expecting an IRIS transfer, you can ignore this email.
        </p>
      </div>
    </div>
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSFER_EMAIL_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        from: env.resendFromEmail,
        to: [params.toEmail],
        subject,
        html
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, reason: `email_error:${text}` };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { sent: false, reason: "email_timeout" };
    }
    const message = error instanceof Error ? error.message : "unknown";
    return { sent: false, reason: `email_exception:${message}` };
  } finally {
    clearTimeout(timeout);
  }

  return { sent: true, reason: "sent" };
};

const sendIrisAccountLoginCodeEmailBestEffort = async (params: {
  email: string;
  code: string;
  expiresAt: Date;
}): Promise<{ sent: boolean; reason: string }> => {
  if (!env.resendApiKey || !env.resendFromEmail) {
    return { sent: false, reason: "email_not_configured" };
  }

  const expiresLabel = params.expiresAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
  const accountUrl = `${env.baseStorefrontUrl.replace(/\/$/, "")}/apps/iris/v3/account`;
  const subject = "Your IRIS account code";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#F3F4F8;color:#111827;padding:32px;">
      <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:22px;padding:30px;box-shadow:0 18px 48px rgba(15,23,42,.08);">
        <div style="font-size:12px;text-transform:uppercase;color:#6B7280;margin-bottom:14px;">IRIS Account</div>
        <h1 style="margin:0 0 16px;font-size:34px;line-height:1.05;font-weight:700;color:#111827;">Sign in to your IRIS account.</h1>
        <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#4B5563;">
          Enter this code on the IRIS Account page to view your library and profile.
        </p>
        <div style="margin:24px 0;padding:20px 22px;border:1px solid #111827;background:#FFFFFF;text-align:center;">
          <div style="font-size:11px;text-transform:uppercase;color:#6B7280;margin-bottom:10px;">Login Code</div>
          <div style="font-size:34px;font-weight:700;color:#111827;">${escapeHtml(params.code)}</div>
        </div>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#6B7280;">
          This code expires around ${escapeHtml(expiresLabel)}.
        </p>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#6B7280;">
          IRIS Account: <a href="${escapeHtml(accountUrl)}" style="color:#111827;">${escapeHtml(accountUrl)}</a>
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6B7280;">
          If you did not request this code, you can ignore this email.
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.resendFromEmail,
        to: [params.email],
        subject,
        html
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, reason: `email_error:${text}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return { sent: false, reason: `email_exception:${message}` };
  }

  return { sent: true, reason: "sent" };
};

type OrderAssignmentEmailItem = {
  irisId: string;
  displayIrisId: string;
  status: ArtworkStatus;
  imageUrl: string | null;
  rarityCode: string | null;
  weightGrams: number | null;
  activatedAt: Date | null;
};

const ORDER_ASSIGNMENT_UNREVEALED_IMAGE =
  "https://cdn.shopify.com/s/files/1/0710/5239/4589/files/P1.png?v=1769584244";

const formatOrderAssignmentStatus = (item: OrderAssignmentEmailItem): string => {
  if (item.status === "activated") return "Activated";
  if (item.status === "assigned") return "Awaiting activation";
  return item.status.replace(/_/g, " ");
};

const sendOrderAssignmentEmailBestEffort = async (params: {
  toEmail: string;
  orderNumber: string | null;
  items: OrderAssignmentEmailItem[];
}): Promise<{ sent: boolean; reason: string }> => {
  if (!env.resendApiKey || !env.resendFromEmail) {
    return { sent: false, reason: "email_not_configured" };
  }
  if (params.items.length === 0) {
    return { sent: false, reason: "no_assigned_items" };
  }

  const orderLabel = params.orderNumber || "your order";
  const accountUrl = `${env.baseStorefrontUrl.replace(/\/$/, "")}/apps/iris/v3/account?email=${encodeURIComponent(
    params.toEmail
  )}`;
  const isPlural = params.items.length > 1;
  const subject = isPlural
    ? `Your IRIS works are assigned for ${orderLabel}`
    : `Your IRIS is assigned for ${orderLabel}`;
  const itemRows = params.items
    .map((item) => {
      const isActivated = item.status === "activated";
      const imageUrl = isActivated && item.imageUrl ? item.imageUrl : ORDER_ASSIGNMENT_UNREVEALED_IMAGE;
      const metaLabel = isActivated
        ? `Status: ${formatOrderAssignmentStatus(item)} · Rarity: ${item.rarityCode || "-"} · Weight: ${formatIrisAccountWeight(item.weightGrams)}`
        : `Status: ${formatOrderAssignmentStatus(item)} · Details reveal after activation`;
      return `
        <tr>
          <td style="padding:18px 0;border-top:1px solid #E5E7EB;vertical-align:middle;width:86px;">
            <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(
              isActivated ? item.displayIrisId : "Unrevealed IRIS"
            )}" style="display:block;width:72px;height:72px;object-fit:cover;border:1px solid #E5E7EB;background:#F8FAFC;" />
          </td>
          <td style="padding:18px 0;border-top:1px solid #E5E7EB;vertical-align:middle;">
            <div style="font-size:19px;line-height:1.2;font-weight:700;color:#111827;">${escapeHtml(
              item.displayIrisId
            )}</div>
            <div style="margin-top:7px;font-size:14px;line-height:1.6;color:#6B7280;">
              ${escapeHtml(metaLabel)}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#F3F4F8;color:#111827;padding:32px;">
      <div style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:22px;padding:30px;box-shadow:0 18px 48px rgba(15,23,42,.08);">
        <div style="font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#6B7280;margin-bottom:14px;">IRIS Assignment</div>
        <h1 style="margin:0 0 16px;font-size:34px;line-height:1.05;font-weight:700;color:#111827;">
          ${isPlural ? "Your IRIS works have been assigned." : "Your IRIS has been assigned."}
        </h1>
        <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#4B5563;">
          Thank you for your order. The IRIS ${isPlural ? "works below are" : "work below is"} now linked to ${escapeHtml(
            params.toEmail
          )}. The artwork remains unrevealed until you receive the physical piece, scan the NFC tag, and enter the printed PIN.
        </p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:6px 0 24px;">
          <tbody>${itemRows}</tbody>
        </table>
        <p style="margin:0 0 24px;">
          <a href="${escapeHtml(accountUrl)}" style="display:inline-block;padding:14px 18px;background:#D6B84F;color:#111827;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;">
            Open My IRIS Account
          </a>
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6B7280;">
          If the button does not work, copy this link: <a href="${escapeHtml(accountUrl)}" style="color:#111827;">${escapeHtml(
            accountUrl
          )}</a>
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.resendFromEmail,
        to: [params.toEmail],
        subject,
        html
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, reason: `email_error:${text}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return { sent: false, reason: `email_exception:${message}` };
  }

  return { sent: true, reason: "sent" };
};

const buildIrisAccountVerifyUrl = (email: string): string =>
  `/apps/iris/v3/login/verify?email=${encodeURIComponent(normalizeEmail(email))}`;

const startIrisAccountLoginCode = async (
  email: string,
  options?: { reuseActiveCode?: boolean }
): Promise<
  | { status: "sent"; email: string; verifyUrl: string; expiresAt: Date }
  | { status: "already_sent"; email: string; verifyUrl: string; expiresAt: Date }
  | { status: "send_failed"; email: string; verifyUrl: string; reason: string }
> => {
  const normalizedEmail = normalizeEmail(email);
  const verifyUrl = buildIrisAccountVerifyUrl(normalizedEmail);
  const now = new Date();

  if (options?.reuseActiveCode) {
    const activeCode = await prisma.irisAccountLoginCode.findFirst({
      where: {
        email: normalizedEmail,
        consumed_at: null,
        attempts: { lt: IRIS_LOGIN_CODE_MAX_ATTEMPTS },
        expires_at: { gt: now }
      },
      orderBy: { created_at: "desc" },
      select: { expires_at: true }
    });
    if (activeCode) {
      return { status: "already_sent", email: normalizedEmail, verifyUrl, expiresAt: activeCode.expires_at };
    }
  }

  const code = generateLoginCode();
  const expiresAt = new Date(Date.now() + IRIS_LOGIN_CODE_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.irisAccountLoginCode.updateMany({
      where: {
        email: normalizedEmail,
        consumed_at: null
      },
      data: {
        consumed_at: now
      }
    });
    await tx.irisAccountLoginCode.create({
      data: {
        email: normalizedEmail,
        code_hash: hashLoginCode(normalizedEmail, code),
        expires_at: expiresAt
      }
    });
  });

  const emailResult = await sendIrisAccountLoginCodeEmailBestEffort({
    email: normalizedEmail,
    code,
    expiresAt
  });
  if (!emailResult.sent) {
    await prisma.irisAccountLoginCode.updateMany({
      where: {
        email: normalizedEmail,
        code_hash: hashLoginCode(normalizedEmail, code),
        consumed_at: null
      },
      data: {
        consumed_at: new Date()
      }
    });
    return {
      status: "send_failed",
      email: normalizedEmail,
      verifyUrl,
      reason: emailResult.reason
    };
  }

  return { status: "sent", email: normalizedEmail, verifyUrl, expiresAt };
};

const createCollaboratorSession = async (userId: string) => {
  const rawToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + env.partnerSessionTtlDays * 24 * 60 * 60 * 1000);

  await prisma.collaboratorSession.create({
    data: {
      user_id: userId,
      token_hash: hashOpaqueToken(rawToken),
      expires_at: expiresAt,
      last_seen_at: new Date()
    }
  });

  return { rawToken, expiresAt };
};

const issueCollaboratorInvite = async (params: {
  userId: string;
  email: string;
  fullName: string;
  collectionName: string;
}) => {
  const rawToken = createOpaqueToken();
  const tokenHash = hashOpaqueToken(rawToken);
  const expiresAt = new Date(Date.now() + env.partnerInviteTtlHours * 60 * 60 * 1000);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.collaboratorInvite.updateMany({
      where: {
        user_id: params.userId,
        accepted_at: null,
        revoked_at: null
      },
      data: {
        revoked_at: now
      }
    });

    await tx.collaboratorInvite.create({
      data: {
        user_id: params.userId,
        token_hash: tokenHash,
        sent_to: params.email,
        expires_at: expiresAt
      }
    });

    await tx.collaboratorUser.update({
      where: { id: params.userId },
      data: {
        status: CollaboratorStatus.invited,
        invitation_sent_at: now
      }
    });
  });

  const inviteLink = createPartnerInviteUrl(rawToken);
  let emailSent = false;
  let emailReason = "sent";

  try {
    const emailResult = await sendCollaboratorInviteEmailBestEffort({
      email: params.email,
      fullName: params.fullName,
      collectionName: params.collectionName,
      inviteLink
    });
    emailSent = emailResult.sent;
    emailReason = emailResult.reason;
  } catch (error) {
    emailSent = false;
    emailReason = error instanceof Error ? error.message : "email_failed";
  }

  return {
    inviteLink,
    expiresAt,
    emailSent,
    emailReason
  };
};

const getPartnerAuth = async (req: any) => {
  const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
  const rawToken = cookies[PARTNER_SESSION_COOKIE];
  if (!rawToken) {
    return null;
  }
  const session = await prisma.collaboratorSession.findFirst({
    where: {
      token_hash: hashOpaqueToken(rawToken),
      expires_at: { gt: new Date() }
    },
    include: {
      user: {
        include: {
          collection: true
        }
      }
    }
  });
  if (!session || session.user.status !== CollaboratorStatus.active) {
    return null;
  }
  return { rawToken, session };
};

const requireCollaborator = async (req: any, reply: any) => {
  const auth = await getPartnerAuth(req);
  if (!auth) {
    reply.redirect(302, "/partner/login");
    return null;
  }
  await prisma.collaboratorSession.update({
    where: { id: auth.session.id },
    data: { last_seen_at: new Date() }
  });
  return auth.session;
};

const statusPill = (status: string) => {
  const key = status.toLowerCase();
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    activated: { bg: "#DAFFE9", fg: "#33CC70", label: "Activated" },
    pending_transfer: { bg: "#DBEAFE", fg: "#2563EB", label: "Pending transfer" },
    assigned: { bg: "#FFF9D5", fg: "#D8C029", label: "Assigned" },
    shopify_failed: { bg: "#FEE2E2", fg: "#991B1B", label: "Shopify Failed" }
  };
  const style = map[key] ?? { bg: "#E5E7EB", fg: "#374151", label: status };
  return `<span class="pill" style="background:${style.bg};color:${style.fg};">${style.label}</span>`;
};

const getPendingTransfersByIrisId = async (
  irisIds: string[]
): Promise<Map<string, { to_email: string; expires_at: Date }>> => {
  const uniqueIrisIds = Array.from(new Set(irisIds.filter(Boolean)));
  const byIrisId = new Map<string, { to_email: string; expires_at: Date }>();
  if (uniqueIrisIds.length === 0) {
    return byIrisId;
  }

  const transfers = await prisma.ownershipTransfer.findMany({
    where: {
      iris_id: { in: uniqueIrisIds },
      status: "pending",
      expires_at: { gt: new Date() }
    },
    orderBy: { created_at: "desc" },
    select: {
      iris_id: true,
      to_email: true,
      expires_at: true
    }
  });

  for (const transfer of transfers) {
    if (!byIrisId.has(transfer.iris_id)) {
      byIrisId.set(transfer.iris_id, {
        to_email: transfer.to_email,
        expires_at: transfer.expires_at
      });
    }
  }
  return byIrisId;
};

const activationPill = (type: string) => {
  const key = type.toLowerCase();
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    activated: { bg: "#DAFFE9", fg: "#33CC70", label: "Success" },
    activation_failed: { bg: "#FFF4D6", fg: "#D9822B", label: "Failed" },
    activation_blocked: { bg: "#FEE2E2", fg: "#991B1B", label: "Blocked" }
  };
  const style = map[key] ?? { bg: "#E5E7EB", fg: "#374151", label: type };
  return `<span class="pill" style="background:${style.bg};color:${style.fg};">${style.label}</span>`;
};

const collaboratorPill = (status: CollaboratorStatus | string) => {
  const key = status.toString().toLowerCase();
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    invited: { bg: "#FFF9D5", fg: "#B78103", label: "Invited" },
    active: { bg: "#DAFFE9", fg: "#2F9E67", label: "Active" },
    disabled: { bg: "#FEE2E2", fg: "#991B1B", label: "Disabled" }
  };
  const style = map[key] ?? { bg: "#E5E7EB", fg: "#374151", label: status.toString() };
  return `<span class="pill" style="background:${style.bg};color:${style.fg};">${style.label}</span>`;
};

const buildAdminShell = (title: string, body: string, _searchValue: string, activeTab: string) => {
  const activitiesActive =
    activeTab === "activities" ||
    activeTab === "all" ||
    activeTab === "activated" ||
    activeTab === "unactivated";
  const allActive = activeTab === "all-iris";
  const ordersActive = activeTab === "orders";
  const logsActive = activeTab === "activation-logs";
  const collaboratorsActive = activeTab === "collaborators";
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;600;700&display=swap');
        :root {
          --bg:#F2F2F7;
          --card:#FFFFFF;
          --ink:#0B0F1A;
          --muted:#6B7280;
          --brand:#5E81F4;
          --brand-dark:#3E4AB8;
          --line:#E6E8F2;
          --pill:#EEF2FF;
        }
        *{box-sizing:border-box;}
        body{
          margin:0;
          font-family: 'Lato', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color:var(--ink);
          background:var(--bg);
          font-size:12px;
        }
        a{color:inherit;text-decoration:none;}
        .layout{
          display:grid;
          grid-template-columns:300px 1fr;
          min-height:100vh;
        }
        .sidebar{
          background:#FFFFFF;
          padding:28px 16px;
          border-right:1px solid var(--line);
        }
        .logo{ text-align:center; margin-bottom:18px; }
        .logo-img{ width:100px; height:auto; display:block; margin:0 auto; }
        .sidebar h2{
          font-size:13px;
          color:var(--muted);
          font-weight:600;
          margin:16px 0 12px;
          text-align:center;
        }
        .nav{
          display:flex;
          flex-direction:column;
          gap:10px;
          margin-top:24px;
        }
        .nav a{
          display:block;
          padding:10px 12px;
          border-radius:14px;
          border:1px solid var(--brand);
          color:var(--brand);
          text-align:center;
          font-weight:600;
          font-size:12px;
          background:#fff;
        }
        .nav a.active{
          background:var(--brand);
          color:#fff;
        }
        .main{ padding:32px 28px; background:transparent; }
        .page{ max-width:1100px; margin:0 auto; }
        .title-row{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:16px;
        }
        .title-row h1{margin:0;font-size:16px;}
        .search{
          display:flex;
          align-items:center;
          gap:10px;
          background:#fff;
          border:1px solid var(--line);
          border-radius:999px;
          padding:6px 14px;
          min-width:320px;
          box-shadow:0 6px 16px rgba(15,23,42,.06);
        }
        .search svg{width:16px;height:16px;color:#9CA3AF;}
        .search input{
          border:0;
          outline:0;
          width:100%;
          font-size:12px;
          font-family:inherit;
        }
        .tabs{
          margin:14px 0 18px;
          display:flex;
          gap:8px;
          justify-content:center;
        }
        .tab{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          padding:6px 14px;
          border-radius:999px;
          border:1px solid var(--line);
          background:#fff;
          font-weight:600;
          color:var(--muted);
          font-size:12px;
          min-width:96px;
        }
        .tab.active{
          background:var(--brand);
          border-color:var(--brand);
          color:#fff;
        }
        .pagination{
          display:flex;
          align-items:center;
          gap:10px;
          margin-top:16px;
          font-size:12px;
        }
        .page-link{
          color:var(--brand);
          text-decoration:none;
          padding:6px 10px;
          border:1px solid var(--line);
          border-radius:8px;
          background:#fff;
          font-weight:600;
        }
        .page-link.disabled{pointer-events:none;opacity:0.4;}
        .page-info{color:var(--muted);}
        .card{
          background:var(--card);
          border-radius:18px;
          border:1px solid var(--line);
          padding:20px;
          box-shadow:0 10px 24px rgba(15,23,42,.06);
        }
        .card.table{ padding:0; overflow:hidden; max-width:1100px; margin:0 auto; }
        table{
          width:100%;
          border-collapse:collapse;
          font-size:12px;
        }
        th, td{
          padding:12px 12px;
          border-bottom:1px solid var(--line);
          text-align:left;
          vertical-align:middle;
        }
        th{color:var(--ink);font-weight:600;font-size:14px;letter-spacing:0;}
        tr:last-child td{border-bottom:0;}
        .pill{
          padding:3px 9px;
          border-radius:999px;
          font-size:12px;
          font-weight:700;
          display:inline-block;
        }
        .customer-link{
          color:var(--brand);
          font-weight:700;
          text-decoration:none;
        }
        .customer-link:hover,
        .iris-link:hover,
        .order-iris-id:hover{
          text-decoration:underline;
        }
        .admin-stat-grid{
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:12px;
          margin:18px 0;
        }
        .admin-stat{
          background:#fff;
          border:1px solid var(--line);
          border-radius:14px;
          padding:14px;
          box-shadow:0 6px 16px rgba(15,23,42,.04);
        }
        .admin-stat span{
          display:block;
          color:var(--muted);
          font-size:11px;
          margin-bottom:6px;
        }
        .admin-stat strong{
          display:block;
          font-size:18px;
        }
        .admin-section-title{
          margin:22px 0 10px;
          font-size:14px;
        }
        .thumb{
          width:60px;height:60px;border-radius:0;object-fit:cover;border:1px solid var(--line);
        }
        .file-input{
          position:absolute;
          opacity:0;
          width:0;
          height:0;
          pointer-events:none;
        }
        .file-link{
          font-size:10px;
          color:#5E81F4;
          cursor:pointer;
          text-decoration:none;
          white-space:nowrap;
        }
        .file-link:hover{ text-decoration:underline; }
        .file-name{
          font-size:10px;
          color:#5E81F4;
          white-space:nowrap;
        }
        .file-clear{
          background:transparent;
          border:0;
          color:#5E81F4;
          font-size:12px;
          cursor:pointer;
          padding:0 2px;
          line-height:1;
        }
        .upload-form{ display:flex; gap:10px; align-items:center; flex-wrap:nowrap; }
        .copy-row{
          display:flex;
          align-items:center;
          gap:8px;
          flex-wrap:wrap;
        }
        .copy-input{
          width:min(420px, 100%);
          padding:6px 8px;
          border:1px solid var(--line);
          border-radius:8px;
          font-size:12px;
          color:var(--ink);
        }
        .copy-btn{
          width:auto;
          height:auto;
          padding:6px 10px;
          line-height:1;
        }
        .btn{
          width:80px;
          height:20px;
          padding:0;
          border-radius:8px;
          border:0;
          cursor:pointer;
          font-weight:600;
          font-size:10px;
          line-height:1;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          text-align:center;
          box-sizing:border-box;
        }
        .btn.primary{background:#5E81F4;color:#fff;}
        .btn.secondary{background:#fff;border:1px solid #5E81F4;color:#5E81F4;}
        .upload-form{
          display:flex;gap:8px;align-items:center;
        }
        .order-iris-list{
          display:grid;
          gap:8px;
        }
        .order-iris-item{
          display:grid;
          grid-template-columns:42px 1fr;
          gap:10px;
          align-items:center;
          min-width:180px;
        }
        .order-iris-thumb{
          width:42px;
          height:42px;
          border:1px solid var(--line);
          background:#F8FAFF;
          object-fit:cover;
          display:flex;
          align-items:center;
          justify-content:center;
          color:#94A3B8;
          font-size:12px;
        }
        .order-iris-meta{
          display:grid;
          gap:4px;
        }
        .order-iris-id{
          color:var(--brand);
          font-weight:700;
        }
        .order-iris-title{
          display:flex;
          align-items:center;
          gap:6px;
          flex-wrap:wrap;
        }
        .order-iris-rarity{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-width:24px;
          padding:2px 6px;
          border-radius:999px;
          border:1px solid #F2D879;
          background:#FFF9D5;
          color:#B78103;
          font-size:10px;
          line-height:1.1;
          font-weight:800;
          letter-spacing:.08em;
        }
        .order-iris-rarity--activated{
          border-color:#86EFAC;
          background:#ECFDF3;
          color:#2F9E67;
        }
        .order-iris-status{
          color:var(--muted);
          font-size:11px;
        }
        .btn{
          padding:7px 12px;border-radius:10px;border:0;cursor:pointer;font-weight:600;font-size:12px;
        }
        .btn.primary{background:var(--brand);color:#fff;}
        .btn.secondary{background:#fff;border:1px solid var(--brand);color:var(--brand);}
        .muted{color:var(--muted);font-size:12px;}
        .iris-link{color:var(--brand);font-weight:700;}
        .passport{
          display:grid;
          grid-template-columns:1fr 260px;
          gap:24px;
          align-items:start;
        }
        .passport h2{margin:0 0 12px;}
        .passport-title{
          text-align:center;
          margin:0 0 18px;
          font-size:18px;
        }
        .passport dl{margin:0;display:grid;grid-template-columns:140px 1fr;row-gap:12px;column-gap:12px;font-size:14px;}
        .passport dt{color:var(--muted);}
        .passport dd{margin:0;font-weight:600;}
        .image-box{
          border:1px dashed #CBD5F5;border-radius:14px;padding:16px;text-align:center;background:#F8FAFF;
        }
        .image-box img{width:100%;border-radius:10px;object-fit:cover;}
        @media (max-width: 900px){
          .layout{ grid-template-columns:1fr; }
          .sidebar{ border-right:0; border-bottom:1px solid var(--line); }
          .main{ padding:20px; }
          .passport{ grid-template-columns:1fr; }
          .search{ min-width:0; width:100%; }
          .title-row{ flex-direction:column; align-items:stretch; }
          .admin-stat-grid{ grid-template-columns:repeat(2, minmax(0, 1fr)); }
        }
      </style>
    </head>
    <body>
      <div class="layout">
        <aside class="sidebar">
          <div class="logo">
            <img class="logo-img" src="https://irisnyc.store/cdn/shop/files/IRIS-LOGO_1500x_492d2916-f667-4e0c-9e94-1669d0309d1c.png" alt="IRIS NYC" />
          </div>
          <h2>Admin Dashboard</h2>
          <div class="nav">
            <a class="${allActive ? "active" : ""}" href="/admin">IRIS Archive</a>
            <a class="${ordersActive ? "active" : ""}" href="/admin/orders">Orders</a>
            <a class="${activitiesActive ? "active" : ""}" href="/admin/activities">Activities</a>
            <a class="${logsActive ? "active" : ""}" href="/admin/activation-logs">Activation Logs</a>
            <a class="${collaboratorsActive ? "active" : ""}" href="/admin/collaborators">Collaborators</a>
            <a href="/admin/logout">Log Out</a>
          </div>
        </aside>
        <main class="main">
          <div class="page">
            ${body}
          </div>
        </main>
      </div>
      <script>
        (function () {
          document.querySelectorAll('.upload-form').forEach(function (form) {
            var input = form.querySelector('.file-input');
            var link = form.querySelector('.file-link');
            var name = form.querySelector('[data-file-name]');
            var clear = form.querySelector('[data-file-clear]');
            var upload = form.querySelector('[data-upload-btn]');
            if (!input || !link || !name || !clear || !upload) return;

            function update() {
              if (input.files && input.files.length > 0) {
                name.textContent = input.files[0].name;
                name.hidden = false;
                clear.hidden = false;
                upload.hidden = false;
                link.hidden = true;
              } else {
                name.textContent = '';
                name.hidden = true;
                clear.hidden = true;
                upload.hidden = true;
                link.hidden = false;
              }
            }

            input.addEventListener('change', update);
            clear.addEventListener('click', function () {
              input.value = '';
              update();
            });
            update();
          });

          document.querySelectorAll('[data-copy-link]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var text = btn.getAttribute('data-copy-link') || '';
              if (!text) return;
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text);
              } else {
                var temp = document.createElement('textarea');
                temp.value = text;
                document.body.appendChild(temp);
                temp.select();
                document.execCommand('copy');
                document.body.removeChild(temp);
              }
            });
          });
        })();
      </script>
    </body>
  </html>`;
};

const buildAdminHtml = (
  items: Array<{
    iris_id: string;
    display_iris_id: string;
    status: string;
    assigned_order_id: string | null;
    assigned_customer_email: string | null;
    order_date: Date | null;
    image_url: string | null;
    pin_code: string | null;
  }>,
  searchValue: string,
  activeTab: string,
  page: number,
  hasPrev: boolean,
  hasNext: boolean
) => {
  const rows = items
    .map((item) => {
      return `
        <tr>
          <td>${item.assigned_order_id ?? "-"}</td>
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.display_iris_id}</a></td>
          <td>${statusPill(item.status)}</td>
          <td>${item.assigned_customer_email ?? "-"}</td>
          <td>${item.order_date ? formatDate(item.order_date) : "-"}</td>
        </tr>
      `;
    })
    .join("");

  const statusHidden = activeTab !== "all" ? `<input type="hidden" name="status" value="${activeTab}" />` : "";
  const baseParams = [
    activeTab !== "all" ? `status=${encodeURIComponent(activeTab)}` : "",
    searchValue ? `q=${encodeURIComponent(searchValue)}` : ""
  ].filter(Boolean);
  const prevParams = baseParams.concat(`page=${page - 1}`).join("&");
  const nextParams = baseParams.concat(`page=${page + 1}`).join("&");
  const prevHref = hasPrev ? `/admin/activities?${prevParams}` : "#";
  const nextHref = hasNext ? `/admin/activities?${nextParams}` : "#";

  const body = `
    <div class="title-row">
      <h1>Activities</h1>
      <form class="search" method="GET" action="/admin/activities">
        ${statusHidden}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by IRIS-####, order id or owner email" value="${searchValue ?? ""}" />
      </form>
    </div>
    <div class="tabs">
      <a class="tab ${activeTab === "all" ? "active" : ""}" href="/admin/activities">All</a>
      <a class="tab ${activeTab === "activated" ? "active" : ""}" href="/admin/activities?status=activated">Activated</a>
      <a class="tab ${activeTab === "unactivated" ? "active" : ""}" href="/admin/activities?status=unactivated">Unactivated</a>
    </div>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>Order Number</th>
            <th>IRIS ID</th>
            <th>Status</th>
            <th>Customer Email</th>
            <th>Order Date</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='5'>No records</td></tr>"}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <a class="page-link ${hasPrev ? "" : "disabled"}" href="${prevHref}">Prev</a>
      <span class="page-info">Page ${page}</span>
      <a class="page-link ${hasNext ? "" : "disabled"}" href="${nextHref}">Next</a>
    </div>
  `;
  return buildAdminShell("IRIS Admin", body, searchValue, activeTab);
};

const buildAdminAllHtml = (
  items: Array<{
    iris_id: string;
    display_iris_id: string;
    status: string;
    order_date: Date | null;
    owner_email: string | null;
    activated_at: Date | null;
    image_url: string | null;
    pin_code: string | null;
    weight_grams: number | null;
    rarity_code: string | null;
  }>,
  searchValue: string,
  statusParam: string,
  page: number,
  hasPrev: boolean,
  hasNext: boolean
) => {
  const rows = items
    .map((item) => {
      const imageCell = item.image_url
        ? `<img class="thumb" src="${item.image_url}" alt="${item.iris_id}" />`
        : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#94A3B8;">—</div>`;
      const fileId = `file-${item.iris_id}`;
      return `
        <tr>
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.display_iris_id}</a></td>
          <td>${statusPill(item.status)}</td>
          <td>${item.order_date ? formatDate(item.order_date) : "-"}</td>
          <td>${item.owner_email ?? "-"}</td>
          <td>${item.activated_at ? formatDate(item.activated_at) : "-"}</td>
          <td>${item.pin_code ?? "-"}</td>
          <td>${item.weight_grams != null ? item.weight_grams.toFixed(2) : "-"}</td>
          <td>${item.rarity_code ?? "-"}</td>
          <td>${imageCell}</td>
          <td>
            <form class="upload-form" method="POST" action="/admin/iris/upload" enctype="multipart/form-data">
              <input type="hidden" name="iris_id" value="${item.iris_id}" />
              <input class="file-input" id="${fileId}" type="file" name="image" accept="image/*" required />
              <label class="file-link" for="${fileId}">Choose File</label>
              <span class="file-name" data-file-name hidden></span>
              <button class="file-clear" type="button" data-file-clear hidden>×</button>
              <button class="btn primary" type="submit" data-upload-btn hidden>Upload</button>
            </form>
          </td>
        </tr>
      `;
    })
    .join("");

  const statusHidden = statusParam !== "all" ? `<input type="hidden" name="status" value="${statusParam}" />` : "";
  const baseParams = [
    statusParam !== "all" ? `status=${encodeURIComponent(statusParam)}` : "",
    searchValue ? `q=${encodeURIComponent(searchValue)}` : ""
  ].filter(Boolean);
  const prevParams = baseParams.concat(`page=${page - 1}`).join("&");
  const nextParams = baseParams.concat(`page=${page + 1}`).join("&");
  const prevHref = hasPrev ? `/admin?${prevParams}` : "#";
  const nextHref = hasNext ? `/admin?${nextParams}` : "#";

  const body = `
    <div class="title-row">
      <h1>IRIS Archive</h1>
      <form class="search" method="GET" action="/admin">
        ${statusHidden}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by IRIS-####, order id or owner email" value="${searchValue ?? ""}" />
      </form>
    </div>
    <div class="tabs">
      <a class="tab ${statusParam === "all" ? "active" : ""}" href="/admin">All</a>
      <a class="tab ${statusParam === "activated" ? "active" : ""}" href="/admin?status=activated">Activated</a>
      <a class="tab ${statusParam === "unactivated" ? "active" : ""}" href="/admin?status=unactivated">Unactivated</a>
    </div>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>IRIS ID</th>
            <th>Status</th>
            <th>Order Date</th>
            <th>Owner Email</th>
            <th>Activated At</th>
            <th>PIN</th>
            <th>Weight (g)</th>
            <th>Rarity</th>
            <th>Image</th>
            <th>Upload</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='10'>No records</td></tr>"}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <a class="page-link ${hasPrev ? "" : "disabled"}" href="${prevHref}">Prev</a>
      <span class="page-info">Page ${page}</span>
      <a class="page-link ${hasNext ? "" : "disabled"}" href="${nextHref}">Next</a>
    </div>
  `;
  return buildAdminShell("IRIS Admin", body, searchValue, "all-iris");
};

const parseAdminOrderNumberSortValue = (value: string | null | undefined): number => {
  const number = Number(String(value ?? "").replace(/\D/g, ""));
  return Number.isFinite(number) ? number : 0;
};

const compareAdminArchiveItemsByOrderDate = (
  a: { iris_id: string; assigned_order_id: string | null },
  b: { iris_id: string; assigned_order_id: string | null },
  orderDateById: Map<string, Date>
): number => {
  const dateDiff = (orderDateById.get(b.iris_id)?.getTime() ?? 0) - (orderDateById.get(a.iris_id)?.getTime() ?? 0);
  if (dateDiff !== 0) return dateDiff;

  const orderNumberDiff =
    parseAdminOrderNumberSortValue(b.assigned_order_id) - parseAdminOrderNumberSortValue(a.assigned_order_id);
  if (orderNumberDiff !== 0) return orderNumberDiff;

  return b.iris_id.localeCompare(a.iris_id);
};

type AdminOrderArtworkView = {
  iris_id: string;
  display_iris_id: string;
  image_url: string | null;
  rarity_code: string | null;
  status: string;
  activated_at: Date | null;
  transfer_pending: boolean;
  assigned_order_id: string | null;
  assigned_customer_email: string | null;
  owner_email: string | null;
};

type AdminArtworkWithCollection = Prisma.ArtworkGetPayload<{
  include: {
    collection: {
      select: {
        slug: true;
        edition_size: true;
      };
    };
  };
}>;

type AdminOrderView = {
  key: string;
  lookup_keys: string[];
  order_name: string | null;
  order_number: string | null;
  order_date: Date | null;
  customer_name: string | null;
  email: string | null;
  total_order_count: number | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string | null;
  total_price_cents: number | null;
  artworks: AdminOrderArtworkView[];
};

type AdminCustomerView = {
  email: string;
  customer_name: string | null;
  total_order_count: number;
  orders: AdminOrderView[];
  artworks: AdminOrderArtworkView[];
};

const readJsonRecord = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const joinNameParts = (...parts: Array<string | null>): string | null => {
  const name = parts.filter(Boolean).join(" ").trim();
  return name || null;
};

const readNestedName = (record: Record<string, unknown> | null): string | null => {
  if (!record) return null;
  return readShopifyString(record.name) ?? joinNameParts(readShopifyString(record.first_name), readShopifyString(record.last_name));
};

const extractAdminOrderCustomerName = (rawJson: Prisma.JsonValue | null | undefined): string | null => {
  const order = readJsonRecord(rawJson);
  if (!order) return null;
  const customer = readJsonRecord(order.customer as Prisma.JsonValue | null | undefined);
  const billingAddress = readJsonRecord(order.billing_address as Prisma.JsonValue | null | undefined);
  const shippingAddress = readJsonRecord(order.shipping_address as Prisma.JsonValue | null | undefined);
  const customerDefaultAddress = readJsonRecord(customer?.default_address as Prisma.JsonValue | null | undefined);
  return (
    readNestedName(customer) ??
    readNestedName(shippingAddress) ??
    readNestedName(billingAddress) ??
    readNestedName(customerDefaultAddress)
  );
};

const getAdminOrderDate = (order: {
  created_at_shopify?: Date | null;
  processed_at?: Date | null;
  updated_at_shopify?: Date | null;
  created_at?: Date | null;
}): Date | null => order.created_at_shopify ?? order.processed_at ?? order.updated_at_shopify ?? order.created_at ?? null;

const adminOrderSortValue = (value: Date | null): number => (value ? value.getTime() : 0);

const formatAdminOrderTitle = (order: { order_name: string | null; order_number: string | null; key: string }): string =>
  order.order_name ?? (order.order_number ? `#${order.order_number.replace(/^#/, "")}` : order.key);

const buildAdminCustomerHref = (email: string): string => `/admin/customers/${encodeURIComponent(normalizeEmail(email))}`;

const formatRarityInitials = (rarityCode: string | null | undefined): string | null => {
  const key = rarityCode?.trim().toLowerCase();
  if (!key) return null;
  const map: Record<string, string> = {
    common: "C",
    uncommon: "U",
    rare: "R",
    "ultra rare": "UR",
    "artist edition": "AE"
  };
  return map[key] ?? (key.split(/\s+/).map((part) => part[0]?.toUpperCase() ?? "").join("") || null);
};

const formatAdminOrderArtworkStatusLabel = (item: AdminOrderArtworkView): string => {
  if (item.transfer_pending) return "Pending Transfer";
  if (item.status === "activated") {
    return `Activated${item.activated_at ? ` ${formatDate(item.activated_at)}` : ""}`;
  }
  return "Not Activated";
};

const buildAdminOrderArtworkListHtml = (artworks: AdminOrderArtworkView[], emptyText = "No IRIS linked"): string => {
  if (!artworks.length) return `<span class="muted">${escapeHtml(emptyText)}</span>`;
  return `<div class="order-iris-list">
    ${artworks
      .map((item) => {
        const thumb = item.image_url
          ? `<img class="order-iris-thumb" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.display_iris_id)}" loading="lazy" />`
          : `<span class="order-iris-thumb">—</span>`;
        const rarityBadge = formatRarityInitials(item.rarity_code);
        const rarityBadgeClass =
          item.status === "activated"
            ? "order-iris-rarity order-iris-rarity--activated"
            : "order-iris-rarity";
        return `
          <div class="order-iris-item">
            ${thumb}
            <span class="order-iris-meta">
              <span class="order-iris-title">
                <a class="order-iris-id" href="/admin/iris/${encodeURIComponent(item.iris_id)}">${escapeHtml(item.display_iris_id)}</a>
                ${rarityBadge ? `<span class="${rarityBadgeClass}" title="${escapeHtml(item.rarity_code || "")}">${escapeHtml(rarityBadge)}</span>` : ""}
              </span>
              <span class="order-iris-status">${escapeHtml(formatAdminOrderArtworkStatusLabel(item))}</span>
            </span>
          </div>
        `;
      })
      .join("")}
  </div>`;
};

const buildAdminOrderArtworkViewsById = async (
  artworks: AdminArtworkWithCollection[]
): Promise<Map<string, AdminOrderArtworkView>> => {
  const pendingTransfersByIrisId = await getPendingTransfersByIrisId(artworks.map((item) => item.iris_id));
  return new Map<string, AdminOrderArtworkView>(
    artworks.map((item) => [
      item.iris_id,
      {
        iris_id: item.iris_id,
        display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        status: item.status,
        activated_at: item.activated_at,
        transfer_pending: pendingTransfersByIrisId.has(item.iris_id),
        assigned_order_id: item.assigned_order_id,
        assigned_customer_email: item.assigned_customer_email,
        owner_email: item.owner_email
      } satisfies AdminOrderArtworkView
    ])
  );
};

const collectAdminOrderAliasKeys = (...values: Array<string | null | undefined>): string[] =>
  buildOrderLookupValues(...values).map(normalizeOrderLookupKey).filter(Boolean);

const countAdminCustomerOrdersByEmail = async (email: string): Promise<number> => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return 0;

  const [shopifyOrders, assignedArtworks] = await Promise.all([
    prisma.shopifyOrder.findMany({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      select: {
        id: true,
        shopify_order_id: true,
        order_name: true,
        order_number: true
      },
      take: 1000
    }),
    prisma.artwork.findMany({
      where: {
        assigned_order_id: { not: null },
        assigned_customer_email: { equals: normalizedEmail, mode: "insensitive" }
      },
      select: {
        assigned_order_id: true
      },
      take: 1000
    })
  ]);

  const shopifyAliasKeys = new Set<string>();
  const uniqueOrderKeys = new Set<string>();
  for (const order of shopifyOrders) {
    const keys = collectOrderLookupKeys(order);
    keys.forEach((key) => shopifyAliasKeys.add(key));
    uniqueOrderKeys.add(`shopify:${order.id}`);
  }

  for (const item of assignedArtworks) {
    const keys = collectAdminOrderAliasKeys(item.assigned_order_id);
    if (!keys.length || keys.some((key) => shopifyAliasKeys.has(key))) continue;
    uniqueOrderKeys.add(`legacy:${keys[0]}`);
  }

  return uniqueOrderKeys.size;
};

const loadAdminTotalOrderCountsByEmail = async (emails: string[]): Promise<Map<string, number>> => {
  const uniqueEmails = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  const pairs = await Promise.all(
    uniqueEmails.map(async (email) => [email, await countAdminCustomerOrdersByEmail(email)] as const)
  );
  return new Map(pairs);
};

const formatAdminOrderPaymentLabel = (order: AdminOrderView): string => {
  if (!order.financial_status && order.total_price_cents == null) return "—";
  const status = formatIrisAccountPaymentStatus(order.financial_status);
  const amount = formatIrisAccountOrderMoneyCents(order.total_price_cents, order.currency);
  if (amount === "-" && normalizeIrisAccountStatusKey(order.financial_status) === "paid") return "Paid $0.00";
  return amount === "-" ? status : `${status} ${amount}`;
};

const fulfillmentPill = (status: string | null): string => {
  if (!status) {
    return `<span class="pill" style="background:#F3F4F6;color:#6B7280;">—</span>`;
  }
  const label = formatIrisAccountFulfillmentStatus(status);
  const key = normalizeIrisAccountStatusKey(label);
  const map: Record<string, { bg: string; fg: string }> = {
    preparing: { bg: "#FFF9D5", fg: "#B78103" },
    in_transit: { bg: "#DBEAFE", fg: "#2563EB" },
    delivered: { bg: "#DAFFE9", fg: "#2F9E67" }
  };
  const style = map[key] ?? { bg: "#E5E7EB", fg: "#374151" };
  return `<span class="pill" style="background:${style.bg};color:${style.fg};">${escapeHtml(label)}</span>`;
};

const buildAdminOrdersHtml = (
  orders: AdminOrderView[],
  searchValue: string,
  page: number,
  hasPrev: boolean,
  hasNext: boolean
) => {
  const rows = orders
    .map((order) => {
      const artworksHtml = buildAdminOrderArtworkListHtml(order.artworks);
      const customerLabel = order.customer_name ?? order.email ?? "—";
      const customerHtml = order.email
        ? `<a class="customer-link" href="${escapeHtml(buildAdminCustomerHref(order.email))}">${escapeHtml(customerLabel)}</a>${
            order.customer_name && order.email ? `<div class="muted">${escapeHtml(order.email)}</div>` : ""
          }`
        : escapeHtml(customerLabel);
      const totalOrdersLabel =
        order.total_order_count != null && order.total_order_count > 0
          ? String(order.total_order_count)
          : "—";
      return `
        <tr>
          <td><strong>${escapeHtml(formatAdminOrderTitle(order))}</strong></td>
          <td>${order.order_date ? formatDate(order.order_date) : "—"}</td>
          <td>${customerHtml}</td>
          <td>${totalOrdersLabel}</td>
          <td>${artworksHtml}</td>
          <td>${fulfillmentPill(order.fulfillment_status)}</td>
        </tr>
      `;
    })
    .join("");

  const prevHref = hasPrev
    ? `/admin/orders?${[searchValue ? `q=${encodeURIComponent(searchValue)}` : "", `page=${page - 1}`]
        .filter(Boolean)
        .join("&")}`
    : "#";
  const nextHref = hasNext
    ? `/admin/orders?${[searchValue ? `q=${encodeURIComponent(searchValue)}` : "", `page=${page + 1}`]
        .filter(Boolean)
        .join("&")}`
    : "#";

  const body = `
    <div class="title-row">
      <h1>Orders</h1>
      <form class="search" method="GET" action="/admin/orders">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by order, customer, or IRIS ID" value="${escapeHtml(searchValue)}" />
      </form>
    </div>
    <div class="card table" style="margin-top:18px;">
      <table>
        <thead>
          <tr>
            <th>Order Number</th>
            <th>Date</th>
            <th>Name</th>
            <th>Total Orders</th>
            <th>IRIS Linked</th>
            <th>Fulfillment</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='6'>No orders</td></tr>"}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <a class="page-link ${hasPrev ? "" : "disabled"}" href="${prevHref}">Prev</a>
      <span class="page-info">Page ${page}</span>
      <a class="page-link ${hasNext ? "" : "disabled"}" href="${nextHref}">Next</a>
    </div>
  `;
  return buildAdminShell("IRIS Admin", body, searchValue, "orders");
};

const buildAdminCustomerHtml = (customer: AdminCustomerView): string => {
  const totalOrders = customer.total_order_count;
  const totalIris = customer.artworks.length;
  const activatedIris = customer.artworks.filter((item) => item.status === "activated").length;
  const pendingTransfers = customer.artworks.filter((item) => item.transfer_pending).length;
  const displayName = customer.customer_name ?? customer.email;
  const ordersRows = customer.orders
    .map((order) => {
      return `
        <tr>
          <td><strong>${escapeHtml(formatAdminOrderTitle(order))}</strong></td>
          <td>${order.order_date ? formatDate(order.order_date) : "—"}</td>
          <td>${escapeHtml(formatAdminOrderPaymentLabel(order))}</td>
          <td>${fulfillmentPill(order.fulfillment_status)}</td>
          <td>${buildAdminOrderArtworkListHtml(order.artworks)}</td>
        </tr>
      `;
    })
    .join("");

  const body = `
    <div class="title-row">
      <div>
        <h1>${escapeHtml(displayName)}</h1>
        <div class="muted">${escapeHtml(customer.email)}</div>
      </div>
      <a class="page-link" href="/admin/orders?q=${encodeURIComponent(customer.email)}">Back to Orders</a>
    </div>

    <div class="admin-stat-grid">
      <div class="admin-stat"><span>Total Orders</span><strong>${escapeHtml(String(totalOrders))}</strong></div>
      <div class="admin-stat"><span>Total IRIS</span><strong>${escapeHtml(String(totalIris))}</strong></div>
      <div class="admin-stat"><span>Activated</span><strong>${escapeHtml(String(activatedIris))}</strong></div>
      <div class="admin-stat"><span>Pending Transfer</span><strong>${escapeHtml(String(pendingTransfers))}</strong></div>
    </div>

    <h2 class="admin-section-title">Orders</h2>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>Order Number</th>
            <th>Date</th>
            <th>Payment</th>
            <th>Fulfillment</th>
            <th>IRIS Linked</th>
          </tr>
        </thead>
        <tbody>
          ${ordersRows || "<tr><td colspan='5'>No orders</td></tr>"}
        </tbody>
      </table>
    </div>

    <h2 class="admin-section-title">IRIS Held / Connected</h2>
    <div class="card">
      ${buildAdminOrderArtworkListHtml(customer.artworks, "No IRIS connected")}
    </div>
  `;
  return buildAdminShell("IRIS Customer", body, "", "orders");
};

const buildActivationLogsHtml = (
  items: Array<{ iris_id: string; type: string; created_at: Date }>,
  page: number,
  hasPrev: boolean,
  hasNext: boolean
) => {
  const rows = items
    .map((item) => {
      return `
        <tr>
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.iris_id}</a></td>
          <td>${formatDateTime(item.created_at)}</td>
          <td>${activationPill(item.type)}</td>
        </tr>
      `;
    })
    .join("");

  const prevHref = hasPrev ? `/admin/activation-logs?page=${page - 1}` : "#";
  const nextHref = hasNext ? `/admin/activation-logs?page=${page + 1}` : "#";

  const body = `
    <div class="title-row">
      <h1>Activation Logs</h1>
    </div>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>IRIS ID</th>
            <th>Date &amp; Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='3'>No records</td></tr>"}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <a class="page-link ${hasPrev ? "" : "disabled"}" href="${prevHref}">Prev</a>
      <span class="page-info">Page ${page}</span>
      <a class="page-link ${hasNext ? "" : "disabled"}" href="${nextHref}">Next</a>
    </div>
  `;

  return buildAdminShell("IRIS Admin", body, "", "activation-logs");
};

const buildCollaboratorsAdminHtml = (
  items: Array<{
    id: string;
    full_name: string;
    email: string;
    status: CollaboratorStatus;
    collection_name: string | null;
    edition_size: number | null;
    invitation_sent_at: Date | null;
    last_login_at: Date | null;
  }>
) => {
  const rows = items
    .map((item) => {
      return `
        <tr>
          <td>${escapeHtml(item.full_name)}</td>
          <td>${escapeHtml(item.email)}</td>
          <td>${escapeHtml(item.collection_name ?? "—")}</td>
          <td>${item.edition_size ?? "—"}</td>
          <td>${collaboratorPill(item.status)}</td>
          <td>${item.invitation_sent_at ? formatDateTime(item.invitation_sent_at) : "—"}</td>
          <td>${item.last_login_at ? formatDateTime(item.last_login_at) : "—"}</td>
          <td>
            ${item.status === CollaboratorStatus.invited ? `<form method="POST" action="/admin/collaborators/${item.id}/invite"><button class="btn secondary" type="submit">Resend</button></form>` : `<span class="muted">—</span>`}
          </td>
        </tr>
      `;
    })
    .join("");

  const body = `
    <div class="title-row">
      <h1>Collaborators</h1>
      <a class="btn primary" href="/admin/collaborators/new" style="width:auto;height:auto;padding:10px 14px;">Create New User</a>
    </div>
    <p class="muted" style="margin:10px 0 18px;">Create collaborator accounts, link them to a draft collection, and send an invitation to create their password.</p>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Collection</th>
            <th>Edition Size</th>
            <th>Status</th>
            <th>Invite Sent</th>
            <th>Last Login</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='8'>No collaborators yet</td></tr>"}
        </tbody>
      </table>
    </div>
  `;

  return buildAdminShell("IRIS Admin", body, "", "collaborators");
};

const buildCollaboratorCreateHtml = (options?: {
  error?: string;
  values?: Record<string, string>;
}) => {
  const values = options?.values ?? {};
  const field = (key: string) => escapeHtml(values[key] ?? "");
  const errorHtml = options?.error
    ? `<div class="card" style="border-color:#FCA5A5;background:#FEF2F2;color:#991B1B;margin-bottom:18px;">${escapeHtml(options.error)}</div>`
    : "";
  const inputStyle =
    "width:100%;padding:12px 14px;border:1px solid #D8DDEB;border-radius:12px;font:inherit;background:#fff;";

  const body = `
    <div class="title-row">
      <h1>Create New User</h1>
      <a class="btn secondary" href="/admin/collaborators" style="width:auto;height:auto;padding:10px 14px;">Back</a>
    </div>
    <p class="muted" style="margin:10px 0 18px;">We’ll create a collaborator account, prepare a draft collection, and generate an invite link so they can create their own password.</p>
    ${errorHtml}
    <form method="POST" action="/admin/collaborators">
      <div class="card" style="display:grid;gap:20px;max-width:860px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <label style="display:grid;gap:8px;">
            <span class="muted">Full Name</span>
            <input style="${inputStyle}" type="text" name="full_name" value="${field("full_name")}" required />
          </label>
          <label style="display:grid;gap:8px;">
            <span class="muted">Email</span>
            <input style="${inputStyle}" type="email" name="email" value="${field("email")}" required />
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <label style="display:grid;gap:8px;">
            <span class="muted">Collection Name</span>
            <input style="${inputStyle}" type="text" name="collection_name" value="${field("collection_name")}" placeholder="Sayat Nova Collection" required />
          </label>
          <label style="display:grid;gap:8px;">
            <span class="muted">Collection Slug</span>
            <input style="${inputStyle}" type="text" name="collection_slug" value="${field("collection_slug")}" placeholder="sayat-nova" />
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <label style="display:grid;gap:8px;">
            <span class="muted">Artist / Vendor</span>
            <input style="${inputStyle}" type="text" name="artist_name" value="${field("artist_name")}" placeholder="Gugoco" />
          </label>
          <label style="display:grid;gap:8px;">
            <span class="muted">Edition Size</span>
            <input style="${inputStyle}" type="number" min="1" step="1" name="edition_size" value="${field("edition_size")}" placeholder="100" required />
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div class="muted">If email delivery is not configured yet, we’ll still generate a secure invite link you can copy manually.</div>
          <button class="btn primary" type="submit" style="width:auto;height:auto;padding:12px 16px;">Create User &amp; Invite</button>
        </div>
      </div>
    </form>
  `;

  return buildAdminShell("IRIS Admin", body, "", "collaborators");
};

const buildCollaboratorSuccessHtml = (params: {
  fullName: string;
  email: string;
  collectionName: string;
  collectionSlug: string;
  editionSize: number;
  inviteLink: string;
  emailSent: boolean;
  emailReason: string;
}) => {
  const body = `
    <div class="title-row">
      <h1>Collaborator Ready</h1>
      <a class="btn secondary" href="/admin/collaborators" style="width:auto;height:auto;padding:10px 14px;">Back to Collaborators</a>
    </div>
    <div class="card" style="max-width:860px;display:grid;gap:18px;">
      <div>
        <div class="muted" style="margin-bottom:8px;">Created account</div>
        <h2 style="margin:0 0 8px;font-size:22px;">${escapeHtml(params.fullName)}</h2>
        <div class="muted">${escapeHtml(params.email)}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;">
        <div class="card" style="padding:16px;">
          <div class="muted">Collection</div>
          <div style="margin-top:6px;font-weight:700;">${escapeHtml(params.collectionName)}</div>
        </div>
        <div class="card" style="padding:16px;">
          <div class="muted">Slug</div>
          <div style="margin-top:6px;font-weight:700;">${escapeHtml(params.collectionSlug)}</div>
        </div>
        <div class="card" style="padding:16px;">
          <div class="muted">Edition Size</div>
          <div style="margin-top:6px;font-weight:700;">${params.editionSize}</div>
        </div>
      </div>
      <div class="card" style="padding:16px;background:${params.emailSent ? "#ECFDF3" : "#FFF7ED"};border-color:${params.emailSent ? "#86EFAC" : "#FDBA74"};">
        <div style="font-weight:700;color:${params.emailSent ? "#166534" : "#9A3412"};">
          ${params.emailSent ? "Invitation sent successfully." : "Invitation link generated."}
        </div>
        <div class="muted" style="margin-top:6px;color:${params.emailSent ? "#166534" : "#9A3412"};">
          ${params.emailSent ? "The collaborator can now create a password from the email invite." : `Email delivery skipped (${escapeHtml(params.emailReason)}). Copy the link below and send it manually.`}
        </div>
      </div>
      <div>
        <div class="muted" style="margin-bottom:8px;">Invite Link</div>
        <div class="copy-row">
          <input class="copy-input" type="text" readonly value="${params.inviteLink}" />
          <button class="btn secondary copy-btn" type="button" data-copy-link="${params.inviteLink}">Copy link</button>
        </div>
      </div>
    </div>
  `;
  return buildAdminShell("IRIS Admin", body, "", "collaborators");
};

const buildPartnerShell = (title: string, body: string) => `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        :root {
          --bg:#0A0A09;
          --bg-soft:#111111;
          --line:#272420;
          --gold:#C9A84C;
          --text:#F5F1E8;
          --muted:#B2A99A;
        }
        * { box-sizing:border-box; }
        body {
          margin:0;
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: radial-gradient(circle at top, #151412 0%, #0A0A09 52%);
          color: var(--text);
        }
        a { color: inherit; }
        .page {
          min-height: 100vh;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:32px 18px;
        }
        .panel {
          width:min(100%, 960px);
          background: rgba(17,17,17,.94);
          border:1px solid var(--line);
          box-shadow:0 24px 60px rgba(0,0,0,.35);
        }
        .shell {
          display:grid;
          grid-template-columns: minmax(260px, 0.95fr) 1.05fr;
        }
        .hero {
          padding:40px 32px;
          border-right:1px solid var(--line);
          background: linear-gradient(180deg, rgba(20,18,16,.95), rgba(10,10,9,.98));
        }
        .eyebrow {
          color:var(--gold);
          text-transform:uppercase;
          letter-spacing:.26em;
          font-size:12px;
          margin-bottom:22px;
        }
        .hero h1 {
          margin:0;
          font-size:clamp(2.8rem, 6vw, 4.6rem);
          line-height:.96;
          letter-spacing:-0.06rem;
        }
        .hero p {
          margin:18px 0 0;
          color:var(--muted);
          font-size:16px;
          line-height:1.7;
        }
        .body {
          padding:40px 32px;
        }
        .body h2 {
          margin:0 0 8px;
          font-size:28px;
          letter-spacing:-0.03rem;
        }
        .body p {
          margin:0 0 18px;
          color:var(--muted);
          line-height:1.7;
        }
        .field {
          display:grid;
          gap:8px;
          margin-bottom:14px;
        }
        .field label {
          font-size:12px;
          letter-spacing:.22em;
          text-transform:uppercase;
          color:var(--gold);
        }
        .field input {
          width:100%;
          border:1px solid var(--line);
          background:#151412;
          color:var(--text);
          border-radius:12px;
          padding:14px 16px;
          font:inherit;
        }
        .btn {
          border:0;
          cursor:pointer;
          background:var(--gold);
          color:#111111;
          font-weight:700;
          letter-spacing:.18em;
          text-transform:uppercase;
          font-size:12px;
          padding:14px 18px;
        }
        .ghost {
          display:inline-flex;
          margin-top:18px;
          color:var(--muted);
          text-decoration:none;
        }
        .error {
          margin:0 0 18px;
          padding:14px 16px;
          border:1px solid #7F1D1D;
          background:#1F1111;
          color:#FCA5A5;
        }
        .stats {
          display:grid;
          grid-template-columns:repeat(3,minmax(0,1fr));
          gap:14px;
          margin-top:26px;
        }
        .stat {
          border:1px solid var(--line);
          padding:16px;
          background:#141311;
        }
        .stat .label {
          color:var(--gold);
          text-transform:uppercase;
          letter-spacing:.22em;
          font-size:11px;
        }
        .stat .value {
          margin-top:8px;
          font-size:22px;
          font-weight:700;
        }
        @media (max-width: 820px) {
          .shell { grid-template-columns:1fr; }
          .hero { border-right:0; border-bottom:1px solid var(--line); }
          .stats { grid-template-columns:1fr; }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="panel">
          ${body}
        </div>
      </div>
    </body>
  </html>`;

const buildPartnerLoginHtml = (options?: { error?: string }) => {
  const errorHtml = options?.error ? `<div class="error">${escapeHtml(options.error)}</div>` : "";
  const body = `
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">IRIS Partner Portal</div>
        <h1>Your art.<br/>Our infrastructure.</h1>
        <p>Sign in to review your collection, track invitations, and manage your IRIS collaborator workspace.</p>
      </section>
      <section class="body">
        <h2>Welcome back.</h2>
        <p>Use the email address and password from your collaborator invitation.</p>
        ${errorHtml}
        <form method="POST" action="/partner/login">
          <div class="field">
            <label>Email</label>
            <input type="email" name="email" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input type="password" name="password" required />
          </div>
          <button class="btn" type="submit">Sign In</button>
        </form>
      </section>
    </div>
  `;
  return buildPartnerShell("IRIS Partner Portal", body);
};

const buildPartnerInviteHtml = (params: {
  fullName: string;
  collectionName: string;
  error?: string;
}) => {
  const errorHtml = params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : "";
  const body = `
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">IRIS Partner Portal</div>
        <h1>Hello, ${escapeHtml(params.fullName)}.</h1>
        <p>Your workspace for <strong>${escapeHtml(params.collectionName)}</strong> is ready. Create your password once, then we’ll bring you into the partner dashboard.</p>
      </section>
      <section class="body">
        <h2>Create your password.</h2>
        <p>This invite is one-time and secure. After you set your password, we’ll sign you in automatically.</p>
        ${errorHtml}
        <form method="POST">
          <div class="field">
            <label>New Password</label>
            <input type="password" name="password" minlength="10" required />
          </div>
          <div class="field">
            <label>Confirm Password</label>
            <input type="password" name="password_confirm" minlength="10" required />
          </div>
          <button class="btn" type="submit">Create Password</button>
        </form>
        <a class="ghost" href="/partner/login">Already set up? Sign in</a>
      </section>
    </div>
  `;
  return buildPartnerShell("Create Password • IRIS Partner Portal", body);
};

const buildPartnerDashboardHtml = (params: {
  fullName: string;
  email: string;
  collectionName: string;
  editionSize: number;
  collectionStatus: string;
  revealedCount: number;
}) => {
  const body = `
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">IRIS Partner Portal</div>
        <h1>${escapeHtml(params.collectionName)}</h1>
        <p>${escapeHtml(params.fullName)} · ${escapeHtml(params.email)}</p>
        <div class="stats">
          <div class="stat">
            <div class="label">Edition Size</div>
            <div class="value">${params.editionSize}</div>
          </div>
          <div class="stat">
            <div class="label">Revealed</div>
            <div class="value">${params.revealedCount}</div>
          </div>
          <div class="stat">
            <div class="label">Status</div>
            <div class="value">${escapeHtml(params.collectionStatus)}</div>
          </div>
        </div>
      </section>
      <section class="body">
        <h2>Partner dashboard is ready.</h2>
        <p>We now have the collaborator account system in place: invite, password creation, and partner sign-in are live. Next we can shape this area into the collection-specific dashboard you want.</p>
        <div class="card" style="padding:18px;border:1px solid var(--line);background:#141311;">
          <div class="muted" style="margin-bottom:6px;">Next suggested slice</div>
          <div style="font-size:18px;font-weight:700;">Collection uploads, sales tracking, and payout view</div>
        </div>
        <a class="ghost" href="/partner/logout">Log out</a>
      </section>
    </div>
  `;
  return buildPartnerShell("IRIS Partner Dashboard", body);
};

const IRIS_ACCOUNT_DEFAULT_IMAGE = "https://cdn.shopify.com/s/files/1/0710/5239/4589/files/P1.png?v=1769584244";
const IRIS_ACCOUNT_UNREVEALED_IMAGE = IRIS_ACCOUNT_DEFAULT_IMAGE;
const IRIS_MARKETPLACE_PREVIEW_EMAIL = "info@gugoco.com";

type IrisAccountItem = {
  iris_id: string;
  display_iris_id: string;
  image_url: string | null;
  rarity_code: string | null;
  weight_grams: number | null;
  activated_at: Date | null;
  passport_url: string;
};

type IrisAccountOrderArtworkView = {
  iris_id: string;
  display_iris_id: string;
  image_url: string | null;
  rarity_code: string | null;
  weight_grams: number | null;
  status: string;
  activated_at: Date | null;
  transfer_pending: boolean;
};

type IrisAccountOrderLineView = {
  title: string | null;
  variant_title: string | null;
  quantity: number;
  price_cents: number | null;
};

type IrisAccountOrderView = {
  key: string;
  source: "shopify" | "legacy";
  shopify_order_id: string | null;
  order_name: string | null;
  order_number: string | null;
  order_date: Date | null;
  email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string | null;
  total_price_cents: number | null;
  items: IrisAccountOrderLineView[];
  artworks: IrisAccountOrderArtworkView[];
};

type IrisAccountUserView = {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  profile_public: boolean;
  avatar_iris_id: string | null;
};

type IrisAccountShellOptions = {
  wrapClass?: string;
  user?: IrisAccountUserView;
  sessionToken?: string;
  avatarUrl?: string | null;
};

const irisAccountLongDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: env.adminTimezone,
  year: "numeric",
  month: "long",
  day: "numeric"
});

const irisAccountShortDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: env.adminTimezone,
  year: "numeric",
  month: "numeric",
  day: "numeric"
});

const irisAccountCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const formatIrisAccountArchiveLabel = (irisId: string): string => {
  const clean = String(irisId || "").replace(/^IRIS-?/i, "").trim();
  return clean ? `IRIS No. ${clean}` : "IRIS No.";
};

const formatIrisAccountPassportTitle = (irisId: string): string => {
  const clean = String(irisId || "").replace(/^IRIS-?/i, "").trim();
  return clean ? `IRIS # ${clean}` : "IRIS #";
};

const formatIrisAccountLongDate = (value: Date | null): string => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : irisAccountLongDateFormatter.format(date);
};

const formatIrisAccountShortDate = (value: Date | null): string => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : irisAccountShortDateFormatter.format(date);
};

const formatIrisAccountGold = (value: number | null): string => {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return `${Number(value).toFixed(2)} g (24K)`;
};

const formatIrisAccountWeight = (value: number | null): string => {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return `${Number(value).toFixed(2)} g`;
};

const formatIrisAccountCurrencyUsd = (value: number): string =>
  irisAccountCurrencyFormatter.format(Math.max(0, value));

const formatIrisAccountMoneyCents = (value: number | null, currency?: string | null): string => {
  if (value == null || !Number.isFinite(value)) return "-";
  const safeCurrency = currency?.trim() || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: safeCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(Math.max(0, value) / 100);
  } catch {
    return irisAccountCurrencyFormatter.format(Math.max(0, value) / 100);
  }
};

const formatIrisAccountOrderMoneyCents = (value: number | null, currency?: string | null): string => {
  if (value == null || !Number.isFinite(value)) return "-";
  const safeCurrency = currency?.trim() || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Math.max(0, value) / 100);
  } catch {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Math.max(0, value) / 100);
  }
};

const buildIrisAccountHref = (
  path: string,
  sessionToken?: string,
  params?: Record<string, string | null | undefined>
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) query.set(key, value);
  }
  if (sessionToken) query.set("session", sessionToken);
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
};

const buildIrisArchiveCardHtml = (item: IrisAccountItem, href: string): string => {
  const media = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.iris_id)}" loading="lazy">`
    : `<div class="v2-iris-archive__placeholder"></div>`;

  return `
    <li data-rarity="${escapeHtml(item.rarity_code || "Activated")}">
      <a class="v2-iris-archive__card" href="${escapeHtml(href)}">
        <div class="v2-iris-archive__media">
          ${media}
          <div class="v2-iris-archive__overlay">
            <div class="v2-iris-archive__overlay-meta">Activated: ${escapeHtml(formatIrisAccountShortDate(item.activated_at))}<br>Gold content: ${escapeHtml(formatIrisAccountGold(item.weight_grams))}</div>
          </div>
        </div>
        <div class="v2-iris-archive__body">
          <div class="v2-iris-archive__iris">${escapeHtml(formatIrisAccountArchiveLabel(item.display_iris_id || item.iris_id))}</div>
          <div class="v2-iris-archive__meta">${escapeHtml(item.rarity_code || "Activated")}</div>
        </div>
      </a>
    </li>
  `;
};

const selectIrisAccountAvatarUrl = (items: IrisAccountItem[], avatarIrisId?: string | null): string | null => {
  const selected = avatarIrisId ? items.find((item) => item.iris_id === avatarIrisId && Boolean(item.image_url)) : null;
  return selected?.image_url ?? items.find((item) => Boolean(item.image_url))?.image_url ?? null;
};

const buildIrisArchiveFilterScript = (params: {
  filterClass: string;
  gridId: string;
  emptyId: string;
  emptyAll: string;
  emptyFiltered: string;
}) => `
  <script>
    (function () {
      var buttons = document.querySelectorAll('.${params.filterClass}');
      var items = document.querySelectorAll('#${params.gridId} > li');
      var empty = document.getElementById('${params.emptyId}');
      function applyFilter(rarity) {
        var visible = 0;
        items.forEach(function (item) {
          var itemRarity = (item.getAttribute('data-rarity') || '').toLowerCase();
          var show = rarity === 'all' || itemRarity === rarity.toLowerCase();
          item.hidden = !show;
          if (show) visible += 1;
        });
        if (empty) {
          empty.hidden = visible > 0;
          empty.textContent = rarity === 'all' ? ${JSON.stringify(params.emptyAll)} : ${JSON.stringify(params.emptyFiltered)};
        }
      }
      buttons.forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.preventDefault();
          buttons.forEach(function (candidate) { candidate.classList.remove('is-active'); });
          button.classList.add('is-active');
          applyFilter(button.getAttribute('data-rarity') || 'all');
        });
      });
    })();
  </script>
`;

const buildGoogleAnalyticsHeadHtml = (title: string): string => {
  const measurementId = env.googleAnalyticsId.trim();
  if (!measurementId) return "";
  return `
      <script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}"></script>
      <script>
        (function () {
          var measurementId = ${JSON.stringify(measurementId)};
          var safeUrl = new URL(window.location.href);
          ['session', 'email', 'code', 'token', 'transfer_code'].forEach(function (key) {
            safeUrl.searchParams.delete(key);
          });
          window.dataLayer = window.dataLayer || [];
          function gtag(){ window.dataLayer.push(arguments); }
          gtag('js', new Date());
          gtag('config', measurementId, {
            send_page_view: false
          });
          gtag('event', 'page_view', {
            page_title: ${JSON.stringify(title)},
            page_location: safeUrl.href,
            page_path: safeUrl.pathname + safeUrl.search
          });
        })();
      </script>`;
};

const buildIrisAccountHeaderAccountHtml = (options: IrisAccountShellOptions): string => {
  if (!options.user) {
    return `<a class="header-login" href="/apps/iris/v3/account">Sign In</a>`;
  }

  const sessionQuery = options.sessionToken ? `?session=${encodeURIComponent(options.sessionToken)}` : "";
  const sessionHidden = options.sessionToken
    ? `<input type="hidden" name="session" value="${escapeHtml(options.sessionToken)}" />`
    : "";
  const profileHref = buildIrisAccountHref("/apps/iris/v3/profile", options.sessionToken);
  const libraryHref = buildIrisAccountHref("/apps/iris/v3/account", options.sessionToken);
  const ordersHref = buildIrisAccountHref("/apps/iris/v3/orders", options.sessionToken);
  const avatarUrl = options.avatarUrl || IRIS_ACCOUNT_DEFAULT_IMAGE;
  const displayName = options.user.display_name || `@${options.user.username}`;

  return `
    <form class="account-menu-form" method="POST" action="/apps/iris/v3/logout${sessionQuery}">
      ${sessionHidden}
      <div class="account-menu">
        <button class="account-menu__trigger" type="button" aria-haspopup="true">
          <span class="account-avatar">
            <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(displayName)}">
          </span>
          <span class="account-name">${escapeHtml(displayName)}</span>
        </button>
        <div class="account-menu__dropdown">
          <a href="${escapeHtml(profileHref)}">My Profile</a>
          <a href="${escapeHtml(libraryHref)}">My IRIS</a>
          <a href="${escapeHtml(ordersHref)}">My Orders</a>
          <button type="submit">Log Out</button>
        </div>
      </div>
    </form>
  `;
};

const buildIrisAccountShell = (title: string, body: string, options: IrisAccountShellOptions = {}) => {
  const accountMenuHtml = buildIrisAccountHeaderAccountHtml(options);
  const wrapClass = options.wrapClass ?? "";
  const analyticsHeadHtml = buildGoogleAnalyticsHeadHtml(title);

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <title>${escapeHtml(title)}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link href="https://fonts.googleapis.com/css2?family=Abel&family=Unbounded:wght@400;500;600;700&display=swap" rel="stylesheet" />
      ${analyticsHeadHtml}
      <style>
        * { box-sizing:border-box; }
        :root {
          --iris-black:#000000;
          --iris-surface:#070707;
          --iris-surface-2:#101010;
          --iris-line:rgba(201,168,76,.18);
          --iris-line-strong:rgba(201,168,76,.36);
          --iris-gold:#c9a84c;
          --iris-gold-bright:#eabf50;
          --iris-text:#ede8df;
          --iris-muted:#a89f90;
          --iris-soft:#746d62;
          --iris-danger:#ff6b6b;
          --iris-success:#7bd88f;
          --page-width:1200px;
        }
        html { min-height:100%; background:var(--iris-black); font-size:62.5%; }
        body {
          margin:0;
          min-height:100vh;
          font-family:"Abel", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background:var(--iris-black);
          color:var(--iris-text);
          font-size:1.6rem;
        }
        a { color:inherit; text-decoration:none; }
        .site {
          min-height:100vh;
          display:flex;
          flex-direction:column;
          background:var(--iris-black);
        }
        .site-header {
          background:var(--iris-black);
          border-bottom:1px solid rgba(201,168,76,.14);
          position:sticky;
          top:0;
          z-index:20;
        }
        .header-inner {
          width:min(100%, var(--page-width));
          min-height:112px;
          margin:0 auto;
          padding:0 24px;
          display:grid;
          grid-template-columns:minmax(18rem, 1fr) auto minmax(18rem, 1fr);
          grid-template-areas:"nav logo account";
          align-items:center;
          gap:24px;
        }
        .site-logo {
          grid-area:logo;
          display:inline-flex;
          align-items:center;
          justify-self:center;
          width:90px;
        }
        .site-logo img {
          width:90px;
          height:auto;
          display:block;
        }
        .main-nav {
          grid-area:nav;
          display:flex;
          align-items:center;
          justify-content:flex-start;
          justify-self:start;
          gap:2.2rem;
          color:var(--iris-gold);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:16px;
          text-transform:uppercase;
        }
        .main-nav a {
          opacity:.78;
          border-bottom:1px solid transparent;
          padding:4px 0;
        }
        .main-nav a:hover,
        .main-nav a:focus {
          opacity:1;
          border-bottom-color:var(--iris-gold);
        }
        .main-nav .header-shop-button,
        .main-nav .header-shop-button:visited {
          position:relative;
          min-height:4.2rem;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          padding:1.1rem 5.4rem;
          border:1px solid rgba(237,232,223,.92) !important;
          border-radius:1.2rem;
          background:#111215;
          color:#ffffff !important;
          font-size:1.2rem;
          line-height:1;
          opacity:1 !important;
          overflow:hidden;
          isolation:isolate;
          box-shadow:0 0 0 1px rgba(234,191,80,.18), 0 1rem 2.6rem rgba(0,0,0,.34);
        }
        .main-nav .header-shop-button span {
          position:relative;
          z-index:2;
          white-space:nowrap;
        }
        .main-nav .header-shop-button::before,
        .main-nav .header-shop-button::after {
          content:"";
          position:absolute;
          pointer-events:none;
        }
        .main-nav .header-shop-button::before {
          inset:-155%;
          z-index:0;
          opacity:.72;
          background:conic-gradient(
            from 0deg,
            rgba(255,255,255,0) 0deg,
            #c9a84c 42deg,
            #fff6cf 82deg,
            rgba(255,255,255,0) 132deg,
            #eabf50 190deg,
            #ffffff 244deg,
            rgba(255,255,255,0) 306deg,
            #c9a84c 360deg
          );
          animation:iris-shop-gold-spin 8s cubic-bezier(.56,.15,.28,.86) infinite;
        }
        .main-nav .header-shop-button::after {
          inset:2px;
          z-index:1;
          border-radius:1rem;
          background:
            radial-gradient(circle at 50% 0%, rgba(234,191,80,.25), rgba(234,191,80,0) 46%),
            linear-gradient(180deg, #161616 0%, #090909 100%);
        }
        .main-nav .header-shop-button:hover,
        .main-nav .header-shop-button:focus {
          border-color:#ffffff !important;
          color:#ffffff !important;
        }
        .main-nav .header-shop-button:hover::before,
        .main-nav .header-shop-button:focus::before {
          opacity:1;
        }
        @keyframes iris-shop-gold-spin {
          0% { transform:rotate(10deg) scale(1); }
          50% { transform:rotate(190deg) scale(.82); }
          100% { transform:rotate(370deg) scale(1); }
        }
        .header-account {
          grid-area:account;
          display:flex;
          position:relative;
          justify-content:flex-end;
          align-items:center;
          min-width:18rem;
          justify-self:end;
        }
        .header-login {
          color:var(--iris-gold);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:12px;
          text-transform:uppercase;
        }
        .account-menu-form { margin:0; }
        .account-menu { position:relative; }
        .account-menu::after {
          content:"";
          position:absolute;
          top:100%;
          right:0;
          width:100%;
          min-width:20rem;
          height:1.4rem;
          display:block;
        }
        .account-menu__trigger {
          display:flex;
          align-items:center;
          gap:1.1rem;
          padding:0;
          border:0;
          background:transparent;
          color:var(--iris-text);
          cursor:pointer;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.2rem;
          text-transform:uppercase;
        }
        .account-avatar {
          width:4.8rem;
          height:4.8rem;
          border:1px solid rgba(201,168,76,.32);
          border-radius:50%;
          display:block;
          overflow:hidden;
          background:#111;
          flex:0 0 auto;
        }
        .account-avatar img {
          width:100%;
          height:100%;
          object-fit:cover;
          display:block;
          transform:scale(2.7);
          transform-origin:center;
        }
        .account-name {
          max-width:16rem;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .account-menu__dropdown {
          position:absolute;
          top:calc(100% + 1.2rem);
          right:0;
          min-width:20rem;
          border:1px solid var(--iris-line-strong);
          background:#050505;
          padding:.8rem;
          display:none;
          z-index:40;
          box-shadow:0 1.8rem 4rem rgba(0,0,0,.4);
        }
        .account-menu:hover .account-menu__dropdown,
        .account-menu:focus-within .account-menu__dropdown {
          display:grid;
        }
        .account-menu__dropdown a,
        .account-menu__dropdown button {
          width:100%;
          min-height:4.2rem;
          border:0;
          border-bottom:1px solid rgba(201,168,76,.12);
          background:transparent;
          color:var(--iris-muted);
          padding:1.1rem 1.2rem;
          text-align:left;
          text-transform:uppercase;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.05rem;
          cursor:pointer;
        }
        .account-menu__dropdown a:hover,
        .account-menu__dropdown a:focus,
        .account-menu__dropdown button:hover,
        .account-menu__dropdown button:focus {
          color:var(--iris-gold);
          background:rgba(201,168,76,.06);
        }
        .account-menu__dropdown button:last-child { border-bottom:0; }
        .page {
          flex:1;
          background:var(--iris-black);
        }
        .wrap {
          width:min(100%, var(--page-width));
          margin:0 auto;
          padding:56px 24px 72px;
        }
        .wrap--flush {
          width:100%;
          padding:0;
        }
        .account-notice-wrap {
          width:min(100%, var(--page-width));
          margin:0 auto;
          padding:3.2rem 2.4rem 0;
        }
        .hero {
          padding:58px 0 44px;
          border-bottom:1px solid var(--iris-line);
          display:grid;
          grid-template-columns:minmax(0, 1fr) auto;
          align-items:flex-start;
          justify-content:space-between;
          gap:28px;
        }
        .eyebrow {
          margin:0 0 12px;
          color:var(--iris-gold);
          text-transform:uppercase;
          font-size:12px;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        h1,
        h2,
        .iris-title,
        .footer-brand {
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-weight:500;
        }
        h1 {
          margin:0;
          max-width:820px;
          font-size:66px;
          line-height:.98;
        }
        h2 {
          margin:0 0 14px;
          font-size:28px;
          line-height:1.12;
        }
        p {
          max-width:700px;
          color:var(--iris-muted);
          line-height:1.65;
          font-size:19px;
        }
        .hero p:not(.eyebrow) { margin-bottom:0; }
        .iris-library-hero {
          display:block;
          text-align:center;
          border-bottom:0;
          padding-bottom:2.8rem;
        }
        .iris-library-hero h1 {
          max-width:none;
          margin:0 auto;
        }
        .iris-library-stats {
          max-width:none;
          margin:1.7rem auto 0;
          color:var(--iris-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.9rem;
          line-height:1.5;
          font-style:normal;
          font-weight:400;
        }
        .iris-library-stats strong {
          color:var(--iris-gold-bright);
          font-style:italic;
          font-weight:400;
        }
        .body { padding:34px 0 0; }
        .grid {
          display:grid;
          grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
          gap:8px;
        }
        .card {
          border:1px solid var(--iris-line);
          background:var(--iris-surface);
          padding:26px;
          min-width:0;
        }
        .field {
          display:grid;
          gap:8px;
          margin-bottom:18px;
        }
        label {
          color:var(--iris-gold);
          font-size:12px;
          text-transform:uppercase;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        input[type="email"], input[type="text"] {
          width:100%;
          min-height:54px;
          border:1px solid var(--iris-line-strong);
          background:#030303;
          color:var(--iris-text);
          padding:0 16px;
          font:inherit;
          font-size:20px;
          border-radius:0;
        }
        input[type="checkbox"] { accent-color:var(--iris-gold-bright); }
        .check {
          display:flex;
          align-items:center;
          gap:10px;
          margin:12px 0 22px;
          color:var(--iris-muted);
          text-transform:none;
          font-family:"Abel", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size:18px;
        }
        .visibility-card {
          width:min(100%, 78rem);
          margin:0 auto;
        }
        .visibility-options {
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:1rem;
          margin:2.2rem 0 2rem;
        }
        .visibility-option {
          display:block;
          margin:0;
          color:var(--iris-muted);
          font-family:"Abel", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          text-transform:none;
          cursor:pointer;
        }
        .visibility-option input {
          position:absolute;
          opacity:0;
          pointer-events:none;
        }
        .visibility-option__panel {
          display:block;
          min-height:11rem;
          border:1px solid var(--iris-line);
          background:#030303;
          padding:1.8rem;
          transition:border-color .18s ease, background .18s ease;
        }
        .visibility-option input:checked + .visibility-option__panel {
          border-color:var(--iris-gold-bright);
          background:rgba(201,168,76,.08);
        }
        .visibility-option__title {
          display:block;
          margin:0 0 .8rem;
          color:var(--iris-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.2rem;
          text-transform:uppercase;
        }
        .visibility-option__copy {
          display:block;
          color:var(--iris-muted);
          font-size:1.7rem;
          line-height:1.45;
        }
        .btn {
          min-height:54px;
          border:1px solid var(--iris-gold-bright);
          background:var(--iris-gold-bright);
          color:#050505;
          padding:14px 20px;
          font-weight:700;
          font-size:14px;
          text-transform:uppercase;
          cursor:pointer;
          text-decoration:none;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .btn:hover,
        .btn:focus { background:#f0c95c; border-color:#f0c95c; }
        .btn.secondary {
          background:transparent;
          color:var(--iris-text);
          border-color:var(--iris-line-strong);
        }
        .btn.secondary:hover,
        .btn.secondary:focus {
          background:rgba(201,168,76,.08);
          border-color:var(--iris-gold-bright);
          color:var(--iris-text);
        }
        .muted { color:var(--iris-muted); }
        .error,
        .success {
          margin:0 0 18px;
          padding:14px 16px;
          border:1px solid currentColor;
          background:rgba(255,255,255,.03);
          font-size:18px;
        }
        .error { color:var(--iris-danger); }
        .success { color:var(--iris-success); }
        .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
        .mini { font-size:15px; color:var(--iris-soft); }
        .account-top-actions {
          display:flex;
          flex-wrap:wrap;
          align-items:center;
          justify-content:flex-end;
          gap:1.2rem;
        }
        .v2-iris-archive {
          --v2-archive-gold:#c9a84c;
          --v2-archive-gold-dim:#7a6330;
          --v2-archive-bg:#000000;
          --v2-archive-surface:#171717;
          --v2-archive-surface-2:#1d1d1d;
          --v2-archive-border:rgba(201,168,76,.16);
          --v2-archive-text:#ede8df;
          --v2-archive-text-mid:#a89f90;
          --v2-archive-text-soft:rgba(237,232,223,.62);
          background:var(--v2-archive-bg);
          color:var(--v2-archive-text);
          border-top:1px solid var(--v2-archive-border);
          border-bottom:1px solid var(--v2-archive-border);
        }
        .v2-iris-archive--account {
          margin-left:calc(50% - 50vw);
          margin-right:calc(50% - 50vw);
        }
        .v2-iris-archive--library .v2-iris-archive__wrap {
          padding-top:5rem;
        }
        .v2-iris-archive__wrap {
          max-width:144rem;
          margin:0 auto;
          padding:11rem 4rem 12rem;
        }
        .v2-iris-archive__head {
          text-align:center;
          margin-bottom:4.8rem;
        }
        .v2-iris-archive__eyebrow {
          margin:0 0 1.8rem;
          color:var(--v2-archive-gold-dim);
          text-transform:uppercase;
          letter-spacing:.42rem;
          font-size:1rem;
        }
        .v2-iris-archive__title {
          margin:0;
          color:var(--v2-archive-text) !important;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:clamp(3.2rem, 5vw, 6rem);
          line-height:1.06;
          letter-spacing:.03em;
          font-weight:400;
        }
        .v2-iris-archive__title em {
          color:var(--v2-archive-gold) !important;
          font-style:italic;
          font-weight:400;
        }
        .v2-iris-archive__description {
          max-width:76rem;
          margin:2rem auto 0;
          color:var(--v2-archive-text-mid);
          font-size:1.7rem;
          line-height:1.8;
        }
        .v2-iris-archive__filters {
          display:flex;
          flex-wrap:wrap;
          justify-content:center;
          gap:1.2rem;
          margin:0 0 5.2rem;
        }
        .v2-iris-archive__filter {
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:4.6rem;
          padding:1.2rem 1.9rem;
          border:1px solid var(--v2-archive-border);
          background:rgba(201,168,76,.03);
          color:var(--v2-archive-text-mid);
          text-decoration:none;
          text-transform:uppercase;
          letter-spacing:.22rem;
          font-size:1.05rem;
          transition:all .24s ease;
        }
        .v2-iris-archive__filter:hover,
        .v2-iris-archive__filter.is-active {
          color:var(--v2-archive-gold);
          border-color:rgba(201,168,76,.45);
          background:rgba(201,168,76,.07);
        }
        .v2-iris-archive__status {
          min-height:2.4rem;
          text-align:center;
          margin:0 0 3rem;
          color:var(--v2-archive-text-soft);
          font-size:1.35rem;
          letter-spacing:.08rem;
        }
        .v2-iris-archive__status[hidden] { display:none; }
        .v2-iris-archive__status--error { color:#de7b7b; }
        .v2-iris-archive__grid {
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:.4rem;
          list-style:none;
          padding:0;
          margin:0;
        }
        .v2-iris-archive__card {
          position:relative;
          display:block;
          background:var(--v2-archive-surface);
          border:1px solid var(--v2-archive-border);
          text-decoration:none;
          color:inherit;
          overflow:hidden;
          transition:border-color .25s ease, transform .25s ease;
        }
        .v2-iris-archive__card:hover {
          border-color:rgba(201,168,76,.4);
          transform:translateY(-2px);
        }
        .v2-iris-archive__media {
          position:relative;
          aspect-ratio:1 / 1;
          background:var(--v2-archive-surface-2);
          overflow:hidden;
        }
        .v2-iris-archive__media img {
          position:absolute;
          inset:10%;
          width:80%;
          height:80%;
          object-fit:contain;
          display:block;
          background:#242424;
          transition:transform .45s ease;
        }
        .v2-iris-archive__card:hover .v2-iris-archive__media img {
          transform:scale(1.035);
        }
        .v2-iris-archive__overlay {
          position:absolute;
          inset:0;
          display:flex;
          align-items:end;
          padding:2rem;
          background:linear-gradient(180deg, rgba(8,8,8,.02) 28%, rgba(8,8,8,.76) 100%);
          opacity:0;
          transition:opacity .24s ease;
        }
        .v2-iris-archive__card:hover .v2-iris-archive__overlay {
          opacity:1;
        }
        .v2-iris-archive__overlay-meta {
          color:var(--v2-archive-gold);
          letter-spacing:.12rem;
          font-size:.92rem;
          line-height:1.7;
          white-space:pre-line;
        }
        .v2-iris-archive__body {
          padding:1.8rem 1.9rem 2rem;
          display:flex;
          flex-direction:column;
          gap:.7rem;
        }
        .v2-iris-archive__iris {
          color:var(--v2-archive-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.9rem;
          line-height:1.1;
          letter-spacing:.03em;
        }
        .v2-iris-archive__meta {
          color:var(--v2-archive-gold);
          text-transform:uppercase;
          letter-spacing:.18rem;
          font-size:.95rem;
        }
        .v2-iris-archive__placeholder {
          position:absolute;
          inset:10%;
          background:linear-gradient(145deg, rgba(201,168,76,.1), rgba(255,255,255,.03));
        }
        .v2-passport-page {
          --v2-gold:#c9a84c;
          --v2-gold-dim:#7a6330;
          --v2-surface:#000000;
          --v2-surface-2:#101010;
          --v2-surface-3:#171717;
          --v2-border:rgba(201,168,76,.16);
          --v2-text:#ede8df;
          --v2-text-mid:#a89f90;
          background:var(--v2-surface);
          color:var(--v2-text);
          border-top:1px solid var(--v2-border);
          margin-left:calc(50% - 50vw);
          margin-right:calc(50% - 50vw);
        }
        .v2-passport-shell {
          max-width:136rem;
          margin:0 auto;
          padding:8rem 8rem 10rem;
        }
        .v2-passport-head {
          margin-bottom:4.8rem;
          display:grid;
          grid-template-columns:minmax(0, 1fr) auto;
          align-items:start;
          gap:2.4rem;
        }
        .v2-passport-eyebrow {
          margin:0 0 1.4rem;
          color:var(--v2-gold-dim);
          text-transform:uppercase;
          letter-spacing:.42rem;
          font-size:1rem;
        }
        .v2-passport-page__title {
          margin:0;
          color:var(--v2-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:clamp(3rem, 4.2vw, 5.6rem);
          line-height:1.04;
          letter-spacing:.03em;
          font-weight:400;
        }
        .v2-passport-page__summary {
          margin:1.8rem 0 0;
          max-width:62rem;
          color:var(--v2-text-mid);
          font-size:1.7rem;
          line-height:1.85;
        }
        .v2-passport-grid {
          display:grid;
          grid-template-columns:minmax(0, 1.04fr) minmax(36rem, .96fr);
          gap:5.6rem;
          align-items:start;
        }
        .v2-passport-media {
          background:var(--v2-surface-2);
          border:1px solid var(--v2-border);
          padding:3.2rem;
        }
        .v2-passport-media__button {
          display:block;
          width:100%;
          padding:0;
          border:0;
          background:transparent;
          cursor:zoom-in;
        }
        .v2-passport-media__frame {
          position:relative;
          aspect-ratio:1 / 1;
          background:#202020;
          overflow:hidden;
        }
        .v2-passport-media__frame img {
          width:100%;
          height:100%;
          object-fit:contain;
          display:block;
          background:#202020;
        }
        .v2-passport-side {
          display:grid;
          gap:1.8rem;
        }
        .v2-passport-panel {
          background:var(--v2-surface-2);
          border:1px solid var(--v2-border);
          padding:3.6rem 3.2rem;
        }
        .v2-passport-panel__eyebrow {
          margin:0 0 1.2rem;
          color:var(--v2-gold-dim);
          text-transform:uppercase;
          letter-spacing:.34rem;
          font-size:1rem;
        }
        .v2-passport-panel__title {
          margin:0;
          color:var(--v2-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:clamp(2.8rem, 3.4vw, 4.6rem);
          line-height:1.02;
          font-weight:400;
        }
        .v2-passport-panel__copy {
          margin:1.6rem 0 0;
          color:var(--v2-text-mid);
          font-size:1.6rem;
          line-height:1.8;
        }
        .v2-passport-meta {
          margin-top:3.2rem;
          border-top:1px solid var(--v2-border);
        }
        .v2-passport-meta__row {
          display:flex;
          justify-content:space-between;
          gap:2rem;
          padding:1.7rem 0;
          border-bottom:1px solid var(--v2-border);
        }
        .v2-passport-meta__label {
          color:var(--v2-text-mid);
          text-transform:uppercase;
          letter-spacing:.2rem;
          font-size:1.02rem;
        }
        .v2-passport-meta__value {
          color:var(--v2-text);
          text-align:right;
          font-size:1.55rem;
          line-height:1.5;
        }
        .v2-passport-actions {
          display:flex;
          flex-wrap:wrap;
          gap:1.4rem;
          margin-top:3.2rem;
        }
        .v2-passport-avatar-form { margin:0; display:contents; }
        .v2-passport-button,
        .v2-passport-button:visited {
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:5.6rem;
          padding:1.6rem 2.8rem;
          border:1px solid var(--v2-border);
          background:rgba(201,168,76,.04);
          color:var(--v2-gold);
          text-decoration:none;
          text-transform:uppercase;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          letter-spacing:0;
          font-size:1.4rem;
          font-weight:700;
          cursor:pointer;
          transition:all .25s ease;
        }
        .v2-passport-button:hover {
          border-color:rgba(201,168,76,.5);
          background:rgba(201,168,76,.08);
        }
        .v2-passport-shop {
          display:flex;
          justify-content:center;
          width:100%;
        }
        .v2-passport-shop__button,
        .v2-passport-shop__button:visited {
          position:relative;
          min-height:4.2rem;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          padding:1.1rem 5.4rem;
          border:1px solid rgba(237,232,223,.92) !important;
          border-radius:1.2rem;
          background:#111215;
          color:#ffffff !important;
          text-decoration:none;
          text-transform:uppercase;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.2rem;
          font-weight:700;
          line-height:1;
          letter-spacing:0;
          overflow:hidden;
          isolation:isolate;
          box-shadow:0 0 0 1px rgba(234,191,80,.18), 0 1rem 2.6rem rgba(0,0,0,.34);
        }
        .v2-passport-shop__button span {
          position:relative;
          z-index:2;
          white-space:nowrap;
        }
        .v2-passport-shop__button::before,
        .v2-passport-shop__button::after {
          content:"";
          position:absolute;
          pointer-events:none;
        }
        .v2-passport-shop__button::before {
          inset:-155%;
          z-index:0;
          opacity:.72;
          background:conic-gradient(
            from 0deg,
            rgba(255,255,255,0) 0deg,
            #c9a84c 42deg,
            #fff6cf 82deg,
            rgba(255,255,255,0) 132deg,
            #eabf50 190deg,
            #ffffff 244deg,
            rgba(255,255,255,0) 306deg,
            #c9a84c 360deg
          );
          animation:iris-shop-gold-spin 8s cubic-bezier(.56,.15,.28,.86) infinite;
        }
        .v2-passport-shop__button::after {
          inset:2px;
          z-index:1;
          border-radius:1rem;
          background:
            radial-gradient(circle at 50% 0%, rgba(234,191,80,.25), rgba(234,191,80,0) 46%),
            linear-gradient(180deg, #161616 0%, #090909 100%);
        }
        .v2-passport-shop__button:hover,
        .v2-passport-shop__button:focus {
          border-color:#ffffff !important;
          color:#ffffff !important;
        }
        .v2-passport-shop__button:hover::before,
        .v2-passport-shop__button:focus::before {
          opacity:1;
        }
        .v2-passport-button:disabled {
          opacity:.52;
          cursor:default;
        }
        .v2-passport-button.is-active:disabled {
          opacity:1;
          color:var(--v2-gold);
          background:rgba(201,168,76,.08);
        }
        .v2-passport-button--ghost,
        .v2-passport-button--ghost:visited {
          background:transparent;
        }
        .v2-passport-note {
          margin-top:1.8rem;
          color:var(--v2-text-mid);
          font-size:1.45rem;
          line-height:1.7;
        }
        .v2-passport-error { margin-top:2rem; color:#d68f8f; font-size:1.45rem; }
        .v2-passport-archive {
          margin-top:8rem;
          background:var(--v2-surface-2);
          border-top:1px solid var(--v2-border);
          margin-left:calc(50% - 50vw);
          margin-right:calc(50% - 50vw);
        }
        .v2-passport-archive__wrap {
          max-width:136rem;
          margin:0 auto;
          padding:7rem 8rem;
        }
        .v2-passport-modal {
          position:fixed;
          inset:0;
          display:none;
          align-items:center;
          justify-content:center;
          padding:2.4rem;
          background:rgba(0,0,0,.8);
          z-index:1000;
        }
        .v2-passport-modal__dialog {
          position:relative;
          width:min(100%, 100rem);
          background:#080808;
          border:1px solid var(--v2-border);
        }
        .v2-passport-modal__close {
          position:absolute;
          top:1rem;
          right:1rem;
          z-index:2;
          border:1px solid var(--v2-border);
          background:rgba(8,8,8,.8);
          color:var(--v2-text);
          padding:.8rem 1.2rem;
          cursor:pointer;
          text-transform:uppercase;
          letter-spacing:.14rem;
          font-size:1rem;
        }
        .v2-passport-modal__img {
          width:100%;
          height:auto;
          display:block;
        }
        .iris-transfer-modal {
          position:fixed;
          inset:0;
          display:none;
          align-items:center;
          justify-content:center;
          padding:2.4rem;
          background:rgba(0,0,0,.78);
          z-index:1001;
        }
        .iris-transfer-modal[aria-hidden="false"] { display:flex; }
        .iris-transfer-dialog {
          width:min(100%, 52rem);
          border:1px solid var(--iris-line-strong);
          background:#080808;
          padding:2.8rem;
        }
        .iris-transfer-status {
          min-height:2.2rem;
          margin:1.4rem 0 0;
          color:var(--iris-muted);
          font-size:1.55rem;
        }
        .iris-transfer-status.is-error { color:var(--iris-danger); }
        .iris-grid {
          display:grid;
          grid-template-columns:repeat(3,minmax(0,1fr));
          gap:8px;
          margin-top:16px;
        }
        .iris-card {
          border:1px solid var(--iris-line);
          background:var(--iris-surface);
          overflow:hidden;
          min-width:0;
        }
        .iris-media {
          aspect-ratio:1/1;
          background:var(--iris-surface-2);
          display:flex;
          align-items:center;
          justify-content:center;
          color:var(--iris-soft);
        }
        .iris-media img {
          width:100%;
          height:100%;
          object-fit:cover;
          display:block;
        }
        .iris-info { padding:18px; }
        .iris-title {
          margin:0 0 10px;
          font-size:18px;
          color:var(--iris-text);
        }
        .row {
          display:flex;
          justify-content:space-between;
          gap:14px;
          padding:12px 0;
          border-top:1px solid var(--iris-line);
          color:var(--iris-text);
          font-size:18px;
        }
        .row span {
          color:var(--iris-gold);
          font-size:11px;
          text-transform:uppercase;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .row strong { text-align:right; }
        .iris-orders {
          display:grid;
          gap:1.2rem;
        }
        .iris-order-card {
          border:1px solid var(--iris-line);
          background:var(--iris-surface);
          padding:2.4rem;
        }
        .iris-order-card__head {
          display:grid;
          grid-template-columns:minmax(0, 1fr) auto;
          align-items:start;
          gap:1.8rem;
          margin-bottom:1.8rem;
        }
        .iris-order-card__eyebrow {
          margin:0 0 .8rem;
          color:var(--iris-gold);
          text-transform:uppercase;
          letter-spacing:.24rem;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1rem;
        }
        .iris-order-card__title {
          margin:0;
          color:var(--iris-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:2.4rem;
          line-height:1.12;
          font-weight:400;
        }
        .iris-order-card__total {
          color:var(--iris-gold-bright);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:2.1rem;
          font-style:italic;
          white-space:nowrap;
        }
        .iris-order-card__meta {
          display:grid;
          grid-template-columns:repeat(3, minmax(0, 1fr));
          border-top:1px solid var(--iris-line);
          border-bottom:1px solid var(--iris-line);
        }
        .iris-order-card__meta-item {
          min-width:0;
          padding:1.5rem 1.4rem;
          border-right:1px solid var(--iris-line);
        }
        .iris-order-card__meta-item:last-child { border-right:0; }
        .iris-order-card__label {
          margin:0 0 .6rem;
          color:var(--iris-soft);
          text-transform:uppercase;
          letter-spacing:.18rem;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:.9rem;
        }
        .iris-order-card__value {
          margin:0;
          color:var(--iris-text);
          font-size:1.65rem;
          line-height:1.35;
        }
        .iris-order-card__section {
          margin-top:1.8rem;
        }
        .iris-order-card__section-title {
          margin:0 0 1rem;
          color:var(--iris-gold);
          text-transform:uppercase;
          letter-spacing:.2rem;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1rem;
        }
        .iris-order-lines,
        .iris-order-artworks {
          display:grid;
          gap:.8rem;
        }
        .iris-order-line,
        .iris-order-artwork {
          display:grid;
          grid-template-columns:minmax(0, 1fr) auto;
          align-items:center;
          gap:1rem;
          color:var(--iris-muted);
          font-size:1.6rem;
        }
        .iris-order-artwork {
          grid-template-columns:auto minmax(0, 1fr) auto;
          color:var(--iris-text);
        }
        .iris-order-artwork__thumb {
          width:4.6rem;
          height:4.6rem;
          border:1px solid var(--iris-line);
          background:var(--iris-surface-2);
          display:block;
          object-fit:cover;
        }
        .iris-order-artwork__thumb--unrevealed {
          object-fit:contain;
          padding:.65rem;
          background:#020202;
        }
        .iris-order-artwork__name {
          color:var(--iris-text);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:1.35rem;
        }
        .iris-order-artwork__meta {
          margin-top:.2rem;
          color:var(--iris-muted);
          font-size:1.35rem;
        }
        .iris-order-artwork__link,
        .iris-order-artwork__link:visited {
          color:var(--iris-gold);
          text-transform:uppercase;
          letter-spacing:.18rem;
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:.95rem;
        }
        .site-footer {
          border-top:1px solid rgba(201,168,76,.14);
          background:var(--iris-black);
          color:var(--iris-muted);
        }
        .footer-inner,
        .footer-bottom {
          width:min(100%, var(--page-width));
          margin:0 auto;
          padding-left:24px;
          padding-right:24px;
        }
        .footer-inner {
          display:grid;
          grid-template-columns:1.1fr 1fr;
          gap:40px;
          padding-top:42px;
          padding-bottom:34px;
        }
        .footer-brand {
          color:var(--iris-text);
          font-size:22px;
          margin-bottom:12px;
        }
        .footer-note {
          max-width:460px;
          margin:0;
          color:var(--iris-muted);
          font-size:18px;
        }
        .footer-links {
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:14px 28px;
          align-content:start;
          justify-items:start;
          color:var(--iris-muted);
          font-family:"Unbounded", -apple-system, BlinkMacSystemFont, sans-serif;
          font-size:12px;
          text-transform:uppercase;
        }
        .footer-links a:hover,
        .footer-links a:focus { color:var(--iris-gold); }
        .footer-bottom {
          border-top:1px solid rgba(201,168,76,.14);
          min-height:56px;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:18px;
          font-size:14px;
        }
        .gold-line { color:var(--iris-gold); }
        @media (max-width: 1199px) {
          .v2-iris-archive__grid {
            grid-template-columns:repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 1100px) {
          .header-inner {
            grid-template-columns:minmax(15rem, 1fr) auto minmax(15rem, 1fr);
            gap:18px;
          }
          .main-nav {
            gap:20px;
            font-size:14px;
          }
          .account-name { max-width:12rem; }
        }
        @media (max-width: 989px) {
          .header-inner {
            min-height:112px;
            grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
            grid-template-areas:
              "logo logo"
              "nav account";
            justify-content:stretch;
            justify-items:stretch;
            align-items:center;
            column-gap:1.8rem;
            row-gap:1.1rem;
            padding-top:1.5rem;
            padding-bottom:1.7rem;
          }
          .site-logo,
          .site-logo img {
            width:9.4rem;
          }
          .main-nav {
            gap:0;
            justify-content:flex-start;
            justify-self:start;
            flex-wrap:nowrap;
            font-size:1rem;
          }
          .main-nav .header-shop-button,
          .main-nav .header-shop-button:visited {
            min-height:3.6rem;
            padding:.92rem 3.25rem;
            border-radius:.95rem;
            font-size:1rem;
          }
          .main-nav .header-shop-button::after {
            border-radius:.78rem;
          }
          .header-account {
            justify-content:flex-end;
            min-width:0;
            justify-self:end;
          }
          .account-menu__trigger {
            gap:0;
            font-size:1rem;
          }
          .account-avatar {
            width:4.15rem;
            height:4.15rem;
          }
          .account-name {
            display:none;
          }
          .v2-iris-archive__wrap { padding:9rem 3.2rem 10rem; }
          .v2-iris-archive__grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 820px) {
          .header-inner {
            min-height:108px;
            column-gap:1.6rem;
            row-gap:1rem;
            padding-top:1.6rem;
            padding-bottom:1.8rem;
          }
          .site-logo,
          .site-logo img {
            width:9.1rem;
          }
          .main-nav {
            font-size:1.05rem;
          }
          .main-nav .header-shop-button,
          .main-nav .header-shop-button:visited {
            min-height:3.55rem;
            padding:.9rem 3.1rem;
            border-radius:.92rem;
            font-size:1.05rem;
          }
          .main-nav .header-shop-button::after {
            border-radius:.74rem;
          }
          .account-menu__trigger {
            font-size:1.05rem;
          }
          .account-avatar {
            width:4.1rem;
            height:4.1rem;
          }
          .account-menu__dropdown {
            left:50%;
            right:auto;
            transform:translateX(-50%);
          }
          .wrap { padding:34px 18px 52px; }
          .wrap--flush { padding:0; }
          .hero {
            display:block;
            padding:34px 0 30px;
          }
          h1 { font-size:44px; }
          h2 { font-size:24px; }
          p { font-size:18px; }
          .grid, .iris-grid { grid-template-columns:1fr; }
          .card { padding:22px; }
          .account-top-actions { justify-content:flex-start; margin-top:2rem; }
          .v2-iris-archive__wrap { padding:7rem 2rem 8rem; }
          .v2-iris-archive__grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
          .v2-iris-archive__description {
            font-size:1.6rem;
            line-height:1.75;
          }
          .v2-iris-archive__body { padding:1.4rem 1.2rem 1.6rem; }
          .v2-iris-archive__filters { gap:.8rem; margin-bottom:4rem; }
          .v2-iris-archive__filter {
            width:calc(50% - .4rem);
            padding-inline:1rem;
            letter-spacing:.16rem;
            font-size:.95rem;
          }
          .v2-passport-shell { padding:5.6rem 2rem 7rem; }
          .v2-passport-head { grid-template-columns:1fr; }
          .v2-passport-grid { grid-template-columns:1fr; gap:3.2rem; }
          .v2-passport-media,
          .v2-passport-panel { padding:2rem; }
          .v2-passport-meta__row { display:grid; gap:.4rem; }
          .v2-passport-meta__value { text-align:left; }
          .v2-passport-actions { flex-direction:column; }
          .v2-passport-shop__button,
          .v2-passport-shop__button:visited {
            width:min(100%, 28rem);
            padding:1.05rem 2.4rem;
          }
          .v2-passport-button,
          .v2-passport-button:visited { width:100%; }
          .v2-passport-archive__wrap { padding:7rem 2rem; }
          .iris-order-card { padding:2rem; }
          .iris-order-card__head { grid-template-columns:1fr; }
          .iris-order-card__total { white-space:normal; }
          .iris-order-card__meta { grid-template-columns:1fr 1fr; }
          .iris-order-card__meta-item:nth-child(2n) { border-right:0; }
          .iris-order-card__meta-item:nth-child(n+3) { border-top:1px solid var(--iris-line); }
          .visibility-options { grid-template-columns:1fr; }
          .footer-inner { grid-template-columns:1fr; gap:24px; }
          .footer-bottom { align-items:flex-start; flex-direction:column; padding-top:18px; padding-bottom:18px; }
        }
        @media (max-width: 480px) {
          .header-inner {
            min-height:108px;
            column-gap:1.4rem;
            row-gap:1rem;
            padding-left:1.6rem;
            padding-right:1.6rem;
          }
          .site-logo,
          .site-logo img { width:8.85rem; }
          .main-nav { font-size:1rem; gap:0; }
          .main-nav .header-shop-button,
          .main-nav .header-shop-button:visited {
            min-height:3.35rem;
            padding:.82rem 2.55rem;
            border-radius:.9rem;
            font-size:1rem;
          }
          .main-nav .header-shop-button::after { border-radius:.72rem; }
          h1 { font-size:36px; }
          .account-menu__trigger { font-size:1rem; }
          .account-avatar { width:3.85rem; height:3.85rem; }
          .iris-order-card__meta { grid-template-columns:1fr; }
          .iris-order-card__meta-item,
          .iris-order-card__meta-item:nth-child(2n) { border-right:0; }
          .iris-order-card__meta-item + .iris-order-card__meta-item { border-top:1px solid var(--iris-line); }
          .iris-order-line,
          .iris-order-artwork {
            grid-template-columns:1fr;
            align-items:start;
          }
          .iris-order-artwork__thumb { display:none; }
          .actions .btn,
          form .btn { width:100%; }
          .footer-links { grid-template-columns:1fr; }
          .v2-iris-archive__iris { font-size:1.55rem; }
          .v2-iris-archive__meta,
          .v2-iris-archive__overlay-meta { font-size:.82rem; letter-spacing:.14rem; }
        }
      </style>
    </head>
    <body>
      <div class="site">
        <header class="site-header">
          <div class="header-inner">
            <a class="site-logo" href="/" aria-label="IRIS NYC Home">
              <img src="https://irisnyc.store/cdn/shop/files/blacklogo_4x_fab96a79-d7af-4c49-968e-176fa1fb41e6.png?v=1776815083&width=180" alt="IRIS NYC" />
            </a>
            <nav class="main-nav" aria-label="Main navigation">
              <a class="header-shop-button" href="/products/iris-the-unseen-edition"><span>Shop IRIS</span></a>
            </nav>
            <div class="header-account">
              ${accountMenuHtml}
            </div>
          </div>
        </header>
        <main class="page">
          <div class="wrap${wrapClass ? ` ${escapeHtml(wrapClass)}` : ""}">
            ${body}
          </div>
        </main>
        <footer class="site-footer">
          <div class="footer-inner">
            <div>
              <div class="footer-brand">IRIS NYC</div>
              <p class="footer-note">Collectible physical art, activated through ownership and preserved in the IRIS archive.</p>
            </div>
            <nav class="footer-links" aria-label="Footer navigation">
              <a href="/pages/iris-archive">Gallery</a>
              <a href="/pages/what-is-iris">What Is IRIS</a>
              <a href="/pages/iris-points">Partnership</a>
              <a href="/pages/collaborate">Collaborate</a>
              <a href="/policies/privacy-policy">Privacy Policy</a>
              <a href="/policies/terms-of-service">Terms Of Service</a>
            </nav>
          </div>
          <div class="footer-bottom">
            <span>© 2026 IRIS NYC</span>
            <span class="gold-line" data-iris-account-gold-price>24K Gold · live price loading</span>
          </div>
        </footer>
      </div>
      <script>
        (function () {
          var node = document.querySelector('[data-iris-account-gold-price]');
          if (!node) return;
          function renderGoldPrice(value) {
            var price = Number(value);
            if (!Number.isFinite(price) || price <= 0) return;
            node.textContent = '24K Gold · $' + price.toFixed(2) + ' / g';
          }
          try {
            var cached = window.localStorage && window.localStorage.getItem('iris_goldapi_usd_g');
            if (cached) {
              var parsed = JSON.parse(cached);
              if (parsed && Date.now() - Number(parsed.ts || 0) < 900000) renderGoldPrice(parsed.price);
            }
          } catch (error) {}
          fetch('/apps/iris/gold-price', { headers: { Accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('gold_price_failed');
              return response.json();
            })
            .then(function (data) {
              renderGoldPrice(data.price_usd_g);
              try {
                if (window.localStorage) {
                  window.localStorage.setItem('iris_goldapi_usd_g', JSON.stringify({ price: data.price_usd_g, ts: Date.now() }));
                }
              } catch (error) {}
            })
            .catch(function () {
              if (node.textContent.indexOf('loading') !== -1) node.textContent = '24K Gold · price unavailable';
            });
        })();
      </script>
    </body>
  </html>`;
};

const buildIrisAccountLoginHtml = (options?: { error?: string; success?: string; email?: string }) => {
  const errorHtml = options?.error ? `<div class="error">${escapeHtml(options.error)}</div>` : "";
  const successHtml = options?.success ? `<div class="success">${escapeHtml(options.success)}</div>` : "";
  const body = `
    <section class="hero">
      <div>
        <p class="eyebrow">IRIS Account</p>
        <h1>Your IRIS account.</h1>
        <p>Access your collection, profile, and future ownership tools directly through IRIS.</p>
      </div>
    </section>
    <section class="body">
      ${errorHtml}
      ${successHtml}
      <form method="POST" action="/apps/iris/v3/login/request">
        <div class="field">
          <label>Email</label>
          <input type="email" name="email" value="${escapeHtml(options?.email ?? "")}" autocomplete="email" required />
        </div>
        <button class="btn" type="submit">Email Login Code</button>
      </form>
      <p class="mini">Access is currently available by direct invite.</p>
    </section>
    <script>
      try {
        window.localStorage && window.localStorage.removeItem("iris_account_session");
      } catch (error) {}
    </script>
  `;
  return buildIrisAccountShell("IRIS Account", body);
};

const buildIrisAccountVerifyHtml = (params: { email: string; error?: string }) => {
  const errorHtml = params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : "";
  const body = `
    <section class="hero">
      <div>
        <p class="eyebrow">IRIS Account</p>
        <h1>Enter your code.</h1>
        <p>We sent a six-digit login code to ${escapeHtml(params.email)}.</p>
      </div>
    </section>
    <section class="body">
      ${errorHtml}
      <form method="POST" action="/apps/iris/v3/login/verify">
        <input type="hidden" name="email" value="${escapeHtml(params.email)}" />
        <div class="field">
          <label>Login Code</label>
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required />
        </div>
        <div class="actions">
          <button class="btn" type="submit">Sign In</button>
          <a class="btn secondary" href="/apps/iris/v3/account">Use another email</a>
        </div>
      </form>
    </section>
  `;
  return buildIrisAccountShell("Verify IRIS Account", body);
};

const buildIrisAccountSessionScript = (sessionToken?: string): string =>
  sessionToken
    ? `<script>
        document.cookie = "${IRIS_ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${IRIS_ACCOUNT_SESSION_DAYS * 24 * 60 * 60}; SameSite=Lax; Secure";
        try {
          window.localStorage && window.localStorage.setItem("iris_account_session", "${encodeURIComponent(sessionToken)}");
        } catch (error) {}
      </script>`
    : "";

const buildIrisAccountLibraryHtml = (params: {
  user: IrisAccountUserView;
  sessionToken?: string;
  message?: string;
  error?: string;
  items: IrisAccountItem[];
  goldPriceUsdG?: number | null;
}) => {
  const messageHtml = params.message ? `<div class="success">${escapeHtml(params.message)}</div>` : "";
  const errorHtml = params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : "";
  const noticeHtml =
    messageHtml || errorHtml ? `<div class="account-notice-wrap">${messageHtml}${errorHtml}</div>` : "";
  const cards = params.items
    .map((item) =>
      buildIrisArchiveCardHtml(
        item,
        buildIrisAccountHref("/apps/iris/v3/passport", params.sessionToken, { iris_id: item.iris_id })
      )
    )
    .join("");
  const avatarUrl = selectIrisAccountAvatarUrl(params.items, params.user.avatar_iris_id);
  const irisCountLabel = params.items.length.toLocaleString("en-US");
  const totalGoldGrams = params.items.reduce((sum, item) => {
    const weight = Number(item.weight_grams);
    return Number.isFinite(weight) ? sum + weight : sum;
  }, 0);
  const totalGoldLabel = `${totalGoldGrams.toFixed(2)} g`;
  const goldPriceUsdG = Number(params.goldPriceUsdG);
  const acquisitionTotalUsd = Number.isFinite(goldPriceUsdG) && goldPriceUsdG > 0 ? totalGoldGrams * goldPriceUsdG : null;
  const acquisitionTotalLabel =
    acquisitionTotalUsd == null ? "-" : formatIrisAccountCurrencyUsd(acquisitionTotalUsd);
  const body = `
    ${noticeHtml}
    <div class="wrap">
      <section class="hero iris-library-hero">
        <div>
          <h1>My IRIS</h1>
          <p class="iris-library-stats">
            <strong>${escapeHtml(irisCountLabel)}</strong> IRIS · <strong>${escapeHtml(totalGoldLabel)}</strong> of 24K gold<span class="iris-library-acquisition-total" hidden> · <strong>${escapeHtml(acquisitionTotalLabel)}</strong> acquisition total</span>
          </p>
        </div>
      </section>
    </div>
    <section class="v2-iris-archive v2-iris-archive--library">
        <div class="v2-iris-archive__wrap">
          <div class="v2-iris-archive__filters" id="iris-v3-library-filters">
            <a class="v2-iris-archive__filter iris-v3-filter is-active" data-rarity="all" href="#">All</a>
            <a class="v2-iris-archive__filter iris-v3-filter" data-rarity="Common" href="#">Common</a>
            <a class="v2-iris-archive__filter iris-v3-filter" data-rarity="Uncommon" href="#">Uncommon</a>
            <a class="v2-iris-archive__filter iris-v3-filter" data-rarity="Rare" href="#">Rare</a>
            <a class="v2-iris-archive__filter iris-v3-filter" data-rarity="Ultra Rare" href="#">Ultra Rare</a>
            <a class="v2-iris-archive__filter iris-v3-filter" data-rarity="Artist Edition" href="#">Artist Edition</a>
          </div>

          <p id="iris-v3-library-empty" class="v2-iris-archive__status" ${params.items.length ? "hidden" : ""}>No IRIS activated yet.</p>
          <ul id="iris-v3-library-grid" class="v2-iris-archive__grid">
            ${cards}
          </ul>
        </div>
      </section>
      ${buildIrisArchiveFilterScript({
        filterClass: "iris-v3-filter",
        gridId: "iris-v3-library-grid",
        emptyId: "iris-v3-library-empty",
        emptyAll: "No IRIS activated yet.",
        emptyFiltered: "No IRIS found for this rarity."
      })}
      ${buildIrisAccountSessionScript(params.sessionToken)}
  `;
  return buildIrisAccountShell("IRIS Account", body, {
    user: params.user,
    sessionToken: params.sessionToken,
    avatarUrl,
    wrapClass: "wrap--flush"
  });
};

const buildIrisAccountSettingsHtml = (params: {
  user: IrisAccountUserView;
  sessionToken?: string;
  message?: string;
  error?: string;
  libraryCount: number;
  avatarUrl?: string | null;
}) => {
  const messageHtml = params.message ? `<div class="success">${escapeHtml(params.message)}</div>` : "";
  const errorHtml = params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : "";
  const sessionQuery = params.sessionToken ? `?session=${encodeURIComponent(params.sessionToken)}` : "";
  const sessionHidden = params.sessionToken
    ? `<input type="hidden" name="session" value="${escapeHtml(params.sessionToken)}" />`
    : "";
  const libraryHref = buildIrisAccountHref("/apps/iris/v3/account", params.sessionToken);
  const body = `
    <section class="hero">
      <div>
        <p class="eyebrow">Profile Settings</p>
        <h1>@${escapeHtml(params.user.username)}</h1>
        <p>${escapeHtml(params.user.email)}</p>
      </div>
      <div class="account-top-actions">
        <a class="btn secondary" href="${escapeHtml(libraryHref)}">Back to My IRIS</a>
      </div>
    </section>
    <section class="body">
      ${messageHtml}
      ${errorHtml}
      <div class="grid">
        <section class="card">
          <h2>Profile</h2>
          <p class="muted">Your IRIS identity for future marketplace tools and optional public galleries.</p>
          <form method="POST" action="/apps/iris/v3/profile${sessionQuery}">
            ${sessionHidden}
            <input type="hidden" name="profile_public" value="${params.user.profile_public ? "true" : "false"}" />
            <div class="field">
              <label>Username</label>
              <input type="text" name="username" value="${escapeHtml(params.user.username)}" minlength="3" maxlength="24" required />
            </div>
            <div class="field">
              <label>Display Name</label>
              <input type="text" name="display_name" value="${escapeHtml(params.user.display_name ?? "")}" maxlength="80" />
            </div>
            <button class="btn" type="submit">Save Profile</button>
          </form>
        </section>
        <section class="card visibility-card">
          <h2>Visibility</h2>
          <p class="muted">If your profile is public, your username may appear on marketplace listings when you use marketplace tools. Your email stays private.</p>
          <form method="POST" action="/apps/iris/v3/profile${sessionQuery}">
            ${sessionHidden}
            <input type="hidden" name="username" value="${escapeHtml(params.user.username)}" />
            <input type="hidden" name="display_name" value="${escapeHtml(params.user.display_name ?? "")}" />
            <div class="visibility-options" role="radiogroup" aria-label="Profile visibility">
              <label class="visibility-option">
                <input type="radio" name="profile_public" value="false" ${params.user.profile_public ? "" : "checked"} />
                <span class="visibility-option__panel">
                  <span class="visibility-option__title">Private</span>
                  <span class="visibility-option__copy">Your IRIS library stays visible only inside your account.</span>
                </span>
              </label>
              <label class="visibility-option">
                <input type="radio" name="profile_public" value="true" ${params.user.profile_public ? "checked" : ""} />
                <span class="visibility-option__panel">
                  <span class="visibility-option__title">Public</span>
                  <span class="visibility-option__copy">Your username can appear with future marketplace activity.</span>
                </span>
              </label>
            </div>
            <button class="btn" type="submit">Save Visibility</button>
          </form>
        </section>
      </div>
      ${buildIrisAccountSessionScript(params.sessionToken)}
    </section>
  `;
  return buildIrisAccountShell("IRIS Profile Settings", body, {
    user: params.user,
    sessionToken: params.sessionToken,
    avatarUrl: params.avatarUrl
  });
};

const buildIrisAccountMarketplaceHtml = (params: {
  user: IrisAccountUserView;
  sessionToken?: string;
  avatarUrl?: string | null;
  items: IrisAccountItem[];
}) => {
  const cards = params.items
    .map((item) =>
      buildIrisArchiveCardHtml(
        item,
        buildIrisAccountHref("/apps/iris/v3/marketplace", params.sessionToken, { iris_id: item.iris_id })
      )
    )
    .join("");
  const body = `
    <section class="v2-iris-archive">
      <div class="v2-iris-archive__wrap">
        <div class="v2-iris-archive__head">
          <p class="v2-iris-archive__eyebrow">Marketplace Preview</p>
          <h1 class="v2-iris-archive__title">IRIS <em>Marketplace</em></h1>
        </div>

        <div class="v2-iris-archive__filters" id="iris-v3-marketplace-filters">
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter is-active" data-rarity="all" href="#">All</a>
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter" data-rarity="Common" href="#">Common</a>
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter" data-rarity="Uncommon" href="#">Uncommon</a>
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter" data-rarity="Rare" href="#">Rare</a>
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter" data-rarity="Ultra Rare" href="#">Ultra Rare</a>
          <a class="v2-iris-archive__filter iris-v3-marketplace-filter" data-rarity="Artist Edition" href="#">Artist Edition</a>
        </div>

        <p id="iris-v3-marketplace-empty" class="v2-iris-archive__status" ${params.items.length ? "hidden" : ""}>No marketplace IRIS available yet.</p>
        <ul id="iris-v3-marketplace-grid" class="v2-iris-archive__grid">
          ${cards}
        </ul>
      </div>
    </section>
    ${buildIrisArchiveFilterScript({
      filterClass: "iris-v3-marketplace-filter",
      gridId: "iris-v3-marketplace-grid",
      emptyId: "iris-v3-marketplace-empty",
      emptyAll: "No marketplace IRIS available yet.",
      emptyFiltered: "No marketplace IRIS found for this rarity."
    })}
    ${buildIrisAccountSessionScript(params.sessionToken)}
  `;
  return buildIrisAccountShell("IRIS Marketplace", body, {
    user: params.user,
    sessionToken: params.sessionToken,
    avatarUrl: params.avatarUrl,
    wrapClass: "wrap--flush"
  });
};

const buildIrisAccountPassportHtml = (params: {
  user: IrisAccountUserView;
  item: IrisAccountItem;
  sessionToken?: string;
  avatarUrl?: string | null;
  transferPendingTo?: string | null;
}) => {
  const libraryHref = buildIrisAccountHref("/apps/iris/v3/account", params.sessionToken);
  const imageUrl = params.item.image_url || IRIS_ACCOUNT_DEFAULT_IMAGE;
  const isCurrentAvatar = params.user.avatar_iris_id === params.item.iris_id;
  const canSetAvatar = Boolean(params.item.image_url) && !isCurrentAvatar;
  const sessionQuery = params.sessionToken ? `?session=${encodeURIComponent(params.sessionToken)}` : "";
  const sessionHidden = params.sessionToken
    ? `<input type="hidden" name="session" value="${escapeHtml(params.sessionToken)}" />`
    : "";
  const avatarButtonLabel = isCurrentAvatar ? "Current Avatar" : "Set as Avatar";
  const pendingNote = params.transferPendingTo
    ? `<div class="v2-passport-note">Transfer code is pending for ${escapeHtml(params.transferPendingTo)}.</div>`
    : "";
  const body = `
    <div class="v2-passport-page">
      <div class="v2-passport-shell">
        <div class="v2-passport-head">
          <div>
            <p class="v2-passport-eyebrow">Digital Passport</p>
            <h1 class="v2-passport-page__title">IRIS Passport</h1>
            <p class="v2-passport-page__summary">
              This passport confirms the image, rarity, and gold content assigned to the activated work.
            </p>
          </div>
          <div class="account-top-actions">
            <a href="${escapeHtml(libraryHref)}" class="btn secondary">Back</a>
          </div>
        </div>

        <div class="v2-passport-grid">
          <div class="v2-passport-media">
            <button type="button" class="v2-passport-media__button" id="iris-passport-img-trigger" aria-label="Open IRIS image">
              <div class="v2-passport-media__frame">
                <img id="iris-passport-img" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(params.item.iris_id)}">
              </div>
            </button>
          </div>

          <div class="v2-passport-side">
            <div class="v2-passport-panel">
              <p class="v2-passport-panel__eyebrow">Activated Work</p>
              <h2 class="v2-passport-panel__title">${escapeHtml(formatIrisAccountPassportTitle(params.item.display_iris_id || params.item.iris_id))}</h2>

              <div class="v2-passport-meta">
                <div class="v2-passport-meta__row">
                  <div class="v2-passport-meta__label">Activated</div>
                  <div class="v2-passport-meta__value">${escapeHtml(formatIrisAccountLongDate(params.item.activated_at))}</div>
                </div>
                <div class="v2-passport-meta__row">
                  <div class="v2-passport-meta__label">Gold Content</div>
                  <div class="v2-passport-meta__value">${escapeHtml(formatIrisAccountGold(params.item.weight_grams))}</div>
                </div>
                <div class="v2-passport-meta__row">
                  <div class="v2-passport-meta__label">Rarity</div>
                  <div class="v2-passport-meta__value">${escapeHtml(params.item.rarity_code || "Hidden until activated")}</div>
                </div>
              </div>

              <div class="v2-passport-actions">
                <form class="v2-passport-avatar-form" method="POST" action="/apps/iris/v3/avatar${sessionQuery}">
                  ${sessionHidden}
                  <input type="hidden" name="iris_id" value="${escapeHtml(params.item.iris_id)}" />
                  <button type="submit" class="v2-passport-button${isCurrentAvatar ? " is-active" : ""}" ${canSetAvatar ? "" : "disabled"}>
                    ${escapeHtml(avatarButtonLabel)}
                  </button>
                </form>
                <button type="button" class="v2-passport-button" id="iris-v3-transfer-open">Transfer</button>
                <button type="button" class="v2-passport-button v2-passport-button--ghost" id="iris-v3-sale-button">Sale</button>
              </div>
              ${pendingNote}
              <div id="iris-v3-sale-status" class="v2-passport-note" hidden>Marketplace sale tools are in development.</div>
            </div>
            <div class="v2-passport-shop">
              <a class="v2-passport-shop__button" href="/products/iris-the-unseen-edition"><span>Shop Your IRIS</span></a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="iris-passport-modal" class="v2-passport-modal">
      <div class="v2-passport-modal__dialog">
        <button type="button" id="iris-passport-modal-close" class="v2-passport-modal__close">Close</button>
        <img id="iris-passport-modal-img" src="" alt="" class="v2-passport-modal__img">
      </div>
    </div>

    <div class="iris-transfer-modal" id="iris-v3-transfer-modal" aria-hidden="true">
      <div class="iris-transfer-dialog">
        <h2>Transfer ${escapeHtml(formatIrisAccountPassportTitle(params.item.display_iris_id || params.item.iris_id))}</h2>
        <p class="muted">The new owner will receive a transfer code by email. They must scan the NFC tag and enter that code to claim this IRIS.</p>
        <form id="iris-v3-transfer-form">
          <input type="hidden" name="iris_id" value="${escapeHtml(params.item.iris_id)}" />
          <input type="hidden" name="from_email" value="${escapeHtml(params.user.email)}" />
          <div class="field">
            <label>Recipient Email</label>
            <input type="email" name="to_email" autocomplete="email" required />
          </div>
          <div class="actions">
            <button class="btn" type="submit">Send Transfer Code</button>
            <button class="btn secondary" type="button" id="iris-v3-transfer-cancel">Cancel</button>
          </div>
          <div id="iris-v3-transfer-status" class="iris-transfer-status"></div>
        </form>
      </div>
    </div>

    <script>
      (function () {
        var img = document.getElementById('iris-passport-img');
        var imgTrigger = document.getElementById('iris-passport-img-trigger');
        var modal = document.getElementById('iris-passport-modal');
        var modalImg = document.getElementById('iris-passport-modal-img');
        var modalClose = document.getElementById('iris-passport-modal-close');
        if (imgTrigger && modal && modalImg && img) {
          imgTrigger.addEventListener('click', function () {
            modalImg.src = img.src;
            modal.style.display = 'flex';
          });
        }
        if (modal && modalClose) {
          modalClose.addEventListener('click', function () { modal.style.display = 'none'; });
          modal.addEventListener('click', function (event) {
            if (event.target === modal) modal.style.display = 'none';
          });
        }

        var saleButton = document.getElementById('iris-v3-sale-button');
        var saleStatus = document.getElementById('iris-v3-sale-status');
        if (saleButton && saleStatus) {
          saleButton.addEventListener('click', function () {
            saleStatus.hidden = false;
          });
        }

        var transferOpen = document.getElementById('iris-v3-transfer-open');
        var transferModal = document.getElementById('iris-v3-transfer-modal');
        var transferCancel = document.getElementById('iris-v3-transfer-cancel');
        var transferForm = document.getElementById('iris-v3-transfer-form');
        var transferStatus = document.getElementById('iris-v3-transfer-status');
        function setTransferStatus(message, isError) {
          if (!transferStatus) return;
          transferStatus.textContent = message || '';
          transferStatus.classList.toggle('is-error', Boolean(isError));
        }
        if (transferOpen && transferModal) {
          transferOpen.addEventListener('click', function () {
            transferModal.setAttribute('aria-hidden', 'false');
            setTransferStatus('', false);
          });
        }
        if (transferCancel && transferModal) {
          transferCancel.addEventListener('click', function () {
            transferModal.setAttribute('aria-hidden', 'true');
            setTransferStatus('', false);
          });
          transferModal.addEventListener('click', function (event) {
            if (event.target === transferModal) transferModal.setAttribute('aria-hidden', 'true');
          });
        }
        if (transferForm) {
          transferForm.addEventListener('submit', function (event) {
            event.preventDefault();
            var formData = new FormData(transferForm);
            var payload = {
              iris_id: formData.get('iris_id'),
              from_email: formData.get('from_email'),
              to_email: formData.get('to_email')
            };
            setTransferStatus('Sending transfer code...', false);
            fetch('/apps/iris/transfer-request', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(payload)
            })
              .then(function (res) {
                return res.json().then(function (data) {
                  if (!res.ok) {
                    var error = new Error(data && data.error ? data.error : 'transfer_failed');
                    error.data = data;
                    throw error;
                  }
                  return data;
                });
              })
              .then(function (data) {
                setTransferStatus('Transfer code sent to ' + data.to_email + '. They must scan the NFC tag and enter that code to claim this IRIS.', false);
              })
              .catch(function (error) {
                var code = error && error.message ? error.message : 'transfer_failed';
                var message = 'Transfer could not be started. Please try again.';
                if (code === 'owner_mismatch') message = 'This IRIS is not registered to this account.';
                if (code === 'same_email') message = 'Enter a different email for the new owner.';
                if (code === 'invalid_email') message = 'Please enter a valid email.';
                if (code === 'transfer_email_failed') message = 'We could not send the transfer email. Please try again or contact support.';
                setTransferStatus(message, true);
              });
          });
        }
      })();
    </script>
    ${buildIrisAccountSessionScript(params.sessionToken)}
  `;
  return buildIrisAccountShell(
    `${formatIrisAccountPassportTitle(params.item.display_iris_id || params.item.iris_id)} Passport`,
    body,
    {
      user: params.user,
      sessionToken: params.sessionToken,
      avatarUrl: params.avatarUrl,
      wrapClass: "wrap--flush"
    }
  );
};

const loadIrisAccountItems = async (email: string) => {
  const normalizedEmail = normalizeEmail(email);
  const items = await prisma.artwork.findMany({
    where: {
      status: "activated",
      OR: [
        { owner_email: normalizedEmail },
        { owner_email: null, assigned_customer_email: normalizedEmail }
      ]
    },
    orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }],
    include: {
      collection: {
        select: {
          slug: true,
          name: true,
          edition_size: true
        }
      }
    }
  });

  return items.map((item) => ({
    iris_id: item.iris_id,
    display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
    image_url: item.image_url,
    rarity_code: item.rarity_code,
    weight_grams: item.weight_grams,
    activated_at: item.activated_at,
    passport_url: buildIrisAccountHref("/apps/iris/v3/passport", undefined, { iris_id: item.iris_id })
  }));
};

const loadIrisAccountPassportItem = async (email: string, irisId: string): Promise<IrisAccountItem | null> => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedIrisId = normalizeIrisIdInput(irisId);
  const item = await prisma.artwork.findFirst({
    where: {
      iris_id: normalizedIrisId,
      status: "activated",
      OR: [
        { owner_email: normalizedEmail },
        { owner_email: null, assigned_customer_email: normalizedEmail }
      ]
    },
    include: {
      collection: {
        select: {
          slug: true,
          name: true,
          edition_size: true
        }
      }
    }
  });

  if (!item) {
    return null;
  }

  return {
    iris_id: item.iris_id,
    display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
    image_url: item.image_url,
    rarity_code: item.rarity_code,
    weight_grams: item.weight_grams,
    activated_at: item.activated_at,
    passport_url: buildIrisAccountHref("/apps/iris/v3/passport", undefined, { iris_id: item.iris_id })
  };
};

const loadPendingTransferTo = async (irisId: string): Promise<string | null> => {
  try {
    const transfer = await prisma.ownershipTransfer.findFirst({
      where: {
        iris_id: irisId,
        status: "pending",
        expires_at: { gt: new Date() }
      },
      orderBy: { created_at: "desc" },
      select: { to_email: true }
    });
    return transfer?.to_email ?? null;
  } catch {
    return null;
  }
};

const normalizeOrderLookupKey = (value: string | null | undefined): string =>
  String(value || "").trim().toLowerCase();

const normalizeIrisAccountOrderNameKey = (value: string | null | undefined): string =>
  normalizeOrderLookupKey(value).replace(/^#/, "");

const collectOrderLookupKeys = (order: {
  shopify_order_id?: string | null;
  order_name?: string | null;
  order_number?: string | null;
}): string[] =>
  Array.from(
    new Set(
      [order.shopify_order_id, order.order_name, order.order_number]
        .flatMap((value) => [normalizeOrderLookupKey(value), normalizeIrisAccountOrderNameKey(value)])
        .filter(Boolean)
    )
  );

const formatIrisAccountOrderStatus = (value: string | null): string => {
  if (!value) return "-";
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const normalizeIrisAccountStatusKey = (value: string | null): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const formatIrisAccountPaymentStatus = (value: string | null): string => {
  const key = normalizeIrisAccountStatusKey(value);
  if (!key) return "Pending";
  if (key === "paid") return "Paid";
  if (key === "partially_paid") return "Partially Paid";
  if (key === "refunded") return "Refunded";
  return formatIrisAccountOrderStatus(value);
};

const getIrisAccountOrderTotalCents = (order: IrisAccountOrderView): number | null => {
  if (order.total_price_cents != null && Number.isFinite(order.total_price_cents)) {
    return order.total_price_cents;
  }
  let hasLinePrice = false;
  const lineTotal = order.items.reduce((sum, item) => {
    const price = Number(item.price_cents);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return sum;
    hasLinePrice = true;
    return sum + Math.max(0, price) * Math.max(1, Math.floor(quantity));
  }, 0);
  return hasLinePrice ? lineTotal : null;
};

const formatIrisAccountPaymentLabel = (order: IrisAccountOrderView): string => {
  const status = formatIrisAccountPaymentStatus(order.financial_status);
  const amount = formatIrisAccountOrderMoneyCents(getIrisAccountOrderTotalCents(order), order.currency);
  if (amount === "-" && normalizeIrisAccountStatusKey(order.financial_status) === "paid") return "Paid $0.00";
  return amount === "-" ? status : `${status} ${amount}`;
};

const formatIrisAccountFulfillmentStatus = (value: string | null): string => {
  const key = normalizeIrisAccountStatusKey(value);
  if (!key || key === "unfulfilled" || key === "open" || key === "pending" || key === "pending_fulfillment") {
    return "Preparing";
  }
  if (
    key === "in_transit" ||
    key === "out_for_delivery" ||
    key === "confirmed" ||
    key === "label_printed" ||
    key === "label_purchased" ||
    key === "partially_fulfilled"
  ) {
    return "In Transit";
  }
  if (key === "fulfilled" || key === "delivered" || key === "success" || key === "marked_as_fulfilled") return "Delivered";
  return formatIrisAccountOrderStatus(value);
};

const formatIrisAccountOrderArtworkStatus = (item: IrisAccountOrderArtworkView): string => {
  if (item.transfer_pending) return "Pending Transfer";
  if (item.status === "activated") {
    const date = formatIrisAccountShortDate(item.activated_at);
    return date === "-" ? "Activated" : `Activated ${date}`;
  }
  return "Not Activated";
};

const buildIrisAccountOrderCardHtml = (order: IrisAccountOrderView, sessionToken?: string): string => {
  const orderTitle = order.order_name ?? (order.order_number ? `#${order.order_number}` : order.shopify_order_id) ?? "Order";
  const orderDateLabel = formatIrisAccountLongDate(order.order_date);
  const totalLabel = formatIrisAccountOrderMoneyCents(getIrisAccountOrderTotalCents(order), order.currency);
  const sourceLabel = order.source === "shopify" ? "Shopify Order" : "IRIS Assignment";
  const artworksHtml = order.artworks.length
    ? order.artworks
        .map((item) => {
          const passportHref = buildIrisAccountHref("/apps/iris/v3/passport", sessionToken, { iris_id: item.iris_id });
          const isActivated = item.status === "activated";
          const thumbUrl = isActivated ? item.image_url : IRIS_ACCOUNT_UNREVEALED_IMAGE;
          const thumb = thumbUrl
            ? `<img class="iris-order-artwork__thumb${isActivated ? "" : " iris-order-artwork__thumb--unrevealed"}" src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(isActivated ? item.display_iris_id || item.iris_id : "Unrevealed IRIS")}" loading="lazy">`
            : `<span class="iris-order-artwork__thumb"></span>`;
          const action =
            isActivated
              ? `<a class="iris-order-artwork__link" href="${escapeHtml(passportHref)}">View Passport</a>`
              : `<span class="iris-order-artwork__link">Not Activated</span>`;
          const status = formatIrisAccountOrderArtworkStatus(item);
          const meta = isActivated
            ? `Rarity: ${item.rarity_code || "-"} · Weight: ${formatIrisAccountWeight(item.weight_grams)} · Status: ${status}`
            : `Status: ${status} · Details reveal after activation`;
          return `
            <div class="iris-order-artwork">
              ${thumb}
              <div>
                <div class="iris-order-artwork__name">${escapeHtml(formatIrisAccountArchiveLabel(item.display_iris_id || item.iris_id))}</div>
                <div class="iris-order-artwork__meta">${escapeHtml(meta)}</div>
              </div>
              ${action}
            </div>
          `;
        })
        .join("")
    : `<p class="muted">No IRIS linked yet.</p>`;

  return `
    <article class="iris-order-card">
      <div class="iris-order-card__head">
        <div>
          <p class="iris-order-card__eyebrow">${escapeHtml(sourceLabel)}</p>
          <h2 class="iris-order-card__title">${escapeHtml(orderTitle)}</h2>
        </div>
        <div class="iris-order-card__total">${escapeHtml(totalLabel)}</div>
      </div>
      <div class="iris-order-card__meta">
        <div class="iris-order-card__meta-item">
          <p class="iris-order-card__label">Order Date</p>
          <p class="iris-order-card__value">${escapeHtml(orderDateLabel)}</p>
        </div>
        <div class="iris-order-card__meta-item">
          <p class="iris-order-card__label">Payment</p>
          <p class="iris-order-card__value">${escapeHtml(formatIrisAccountPaymentLabel(order))}</p>
        </div>
        <div class="iris-order-card__meta-item">
          <p class="iris-order-card__label">IRIS Linked</p>
          <p class="iris-order-card__value">${escapeHtml(String(order.artworks.length))}</p>
        </div>
      </div>
      <div class="iris-order-card__section">
        <p class="iris-order-card__section-title">Items</p>
        <div class="iris-order-artworks">${artworksHtml}</div>
      </div>
    </article>
  `;
};

const buildIrisAccountOrdersHtml = (params: {
  user: IrisAccountUserView;
  sessionToken?: string;
  avatarUrl?: string | null;
  orders: IrisAccountOrderView[];
}) => {
  const libraryHref = buildIrisAccountHref("/apps/iris/v3/account", params.sessionToken);
  const ordersHtml = params.orders.length
    ? `<div class="iris-orders">${params.orders
        .map((order) => buildIrisAccountOrderCardHtml(order, params.sessionToken))
        .join("")}</div>`
    : `<p class="v2-iris-archive__status">No Shopify orders are linked to this IRIS account yet.</p>`;
  const body = `
    <section class="hero">
      <div>
        <p class="eyebrow">IRIS Account</p>
        <h1>My Orders</h1>
        <p>Orders connected by verified email. Ownership remains anchored in each IRIS passport.</p>
      </div>
      <div class="account-top-actions">
        <a class="btn secondary" href="${escapeHtml(libraryHref)}">Back to My IRIS</a>
      </div>
    </section>
    <section class="body">
      ${ordersHtml}
      ${buildIrisAccountSessionScript(params.sessionToken)}
    </section>
  `;
  return buildIrisAccountShell("IRIS Orders", body, {
    user: params.user,
    sessionToken: params.sessionToken,
    avatarUrl: params.avatarUrl
  });
};

type IrisAccountShopifyOrderFallback = {
  shopify_order_id: string | null;
  order_name: string | null;
  order_number: string | null;
  order_date: Date | null;
  email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string | null;
  total_price_cents: number | null;
  items: IrisAccountOrderLineView[];
};

const readIrisAccountShopifyFallbackString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const parseIrisAccountShopifyFallbackMoneyCents = (value: unknown): number | null => {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(raw) ? Math.round(raw * 100) : null;
};

const readIrisAccountGraphqlMoneyCents = (value: unknown): number | null => {
  const moneySet = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const shopMoney = moneySet.shopMoney && typeof moneySet.shopMoney === "object"
    ? (moneySet.shopMoney as Record<string, unknown>)
    : {};
  return parseIrisAccountShopifyFallbackMoneyCents(shopMoney.amount);
};

const readIrisAccountGraphqlCurrency = (value: unknown): string | null => {
  const moneySet = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const shopMoney = moneySet.shopMoney && typeof moneySet.shopMoney === "object"
    ? (moneySet.shopMoney as Record<string, unknown>)
    : {};
  return readIrisAccountShopifyFallbackString(shopMoney.currencyCode);
};

const extractIrisAccountGraphqlFulfillmentStatus = (order: Record<string, unknown>): string | null => {
  const fulfillments = Array.isArray(order.fulfillments) ? (order.fulfillments as Array<Record<string, unknown>>) : [];
  for (const fulfillment of fulfillments) {
    if (parseDateValue(fulfillment.deliveredAt)) return "DELIVERED";
  }
  for (const fulfillment of fulfillments) {
    if (parseDateValue(fulfillment.inTransitAt)) return "IN_TRANSIT";
  }
  const preferredKeys = new Set(["delivered", "in_transit", "out_for_delivery"]);
  for (const fulfillment of fulfillments) {
    const status = readIrisAccountShopifyFallbackString(fulfillment.displayStatus) ??
      readIrisAccountShopifyFallbackString(fulfillment.status);
    if (preferredKeys.has(normalizeIrisAccountStatusKey(status))) return status;
  }
  for (const fulfillment of fulfillments) {
    const status = readIrisAccountShopifyFallbackString(fulfillment.displayStatus) ??
      readIrisAccountShopifyFallbackString(fulfillment.status);
    if (status) return status;
  }
  return readIrisAccountShopifyFallbackString(order.displayFulfillmentStatus);
};

const hasSpecificIrisAccountFulfillmentStatus = (value: string | null): boolean => {
  const key = normalizeIrisAccountStatusKey(value);
  return key === "delivered" || key === "in_transit" || key === "out_for_delivery";
};

const mergeIrisAccountShopifyOrderFallbacks = (
  primary: IrisAccountShopifyOrderFallback | null,
  secondary: IrisAccountShopifyOrderFallback | null
): IrisAccountShopifyOrderFallback | null => {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    shopify_order_id: primary.shopify_order_id ?? secondary.shopify_order_id,
    order_name: primary.order_name ?? secondary.order_name,
    order_number: primary.order_number ?? secondary.order_number,
    order_date: primary.order_date ?? secondary.order_date,
    email: primary.email ?? secondary.email,
    financial_status: primary.financial_status ?? secondary.financial_status,
    fulfillment_status: hasSpecificIrisAccountFulfillmentStatus(secondary.fulfillment_status)
      ? secondary.fulfillment_status
      : primary.fulfillment_status ?? secondary.fulfillment_status,
    currency: primary.currency ?? secondary.currency,
    total_price_cents: primary.total_price_cents ?? secondary.total_price_cents,
    items: primary.items.length ? primary.items : secondary.items
  };
};

const extractIrisAccountShopifyGraphqlFallbackOrder = (
  order: Record<string, unknown>
): IrisAccountShopifyOrderFallback | null => {
  const shopifyOrderId =
    readIrisAccountShopifyFallbackString(order.legacyResourceId) ??
    readIrisAccountShopifyFallbackString(order.id) ??
    readIrisAccountShopifyFallbackString(order.name);
  if (!shopifyOrderId) return null;

  const totalMoney = order.currentTotalPriceSet ?? order.totalPriceSet;
  const currency = readIrisAccountGraphqlCurrency(totalMoney) ??
    readIrisAccountShopifyFallbackString(order.currencyCode) ??
    "USD";
  const orderName = readIrisAccountShopifyFallbackString(order.name);
  return {
    shopify_order_id: shopifyOrderId,
    order_name: orderName,
    order_number: orderName?.replace(/^#/, "") ?? null,
    order_date: parseDateValue(order.createdAt) ?? parseDateValue(order.processedAt) ?? parseDateValue(order.updatedAt),
    email: readIrisAccountShopifyFallbackString(order.email),
    financial_status: readIrisAccountShopifyFallbackString(order.displayFinancialStatus),
    fulfillment_status: extractIrisAccountGraphqlFulfillmentStatus(order),
    currency,
    total_price_cents: readIrisAccountGraphqlMoneyCents(totalMoney),
    items: []
  };
};

const extractIrisAccountShopifyFallbackOrder = (
  order: Record<string, unknown>
): IrisAccountShopifyOrderFallback | null => {
  const shopifyOrderId =
    readIrisAccountShopifyFallbackString(order.id) ??
    readIrisAccountShopifyFallbackString(order.admin_graphql_api_id) ??
    readIrisAccountShopifyFallbackString(order.name);
  if (!shopifyOrderId) return null;

  const currency = readIrisAccountShopifyFallbackString(order.currency) ?? "USD";
  const lineItems = Array.isArray(order.line_items) ? (order.line_items as Array<Record<string, unknown>>) : [];
  return {
    shopify_order_id: shopifyOrderId,
    order_name: readIrisAccountShopifyFallbackString(order.name),
    order_number: readIrisAccountShopifyFallbackString(order.order_number),
    order_date: extractShopifyOrderDate(order),
    email: extractCustomerEmail(order),
    financial_status: readIrisAccountShopifyFallbackString(order.financial_status),
    fulfillment_status: extractShopifyFulfillmentStatus(order),
    currency,
    total_price_cents: parseIrisAccountShopifyFallbackMoneyCents(order.current_total_price ?? order.total_price),
    items: lineItems.map((item) => {
      const rawQuantity = Number(item.quantity ?? 1);
      return {
        title: readIrisAccountShopifyFallbackString(item.title) ?? readIrisAccountShopifyFallbackString(item.name),
        variant_title: readIrisAccountShopifyFallbackString(item.variant_title),
        quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.floor(rawQuantity) : 1,
        price_cents: parseIrisAccountShopifyFallbackMoneyCents(item.price)
      };
    })
  };
};

const loadIrisAccountShopifyGraphqlOrderFallback = async (
  searchName: string,
  expectedName: string
): Promise<IrisAccountShopifyOrderFallback | null> => {
  const q = `
    query IrisAccountOrderFallback($query: String!) {
      orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            legacyResourceId
            name
            email
            displayFinancialStatus
            displayFulfillmentStatus
            currencyCode
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            createdAt
            processedAt
            updatedAt
            fulfillments(first: 10) {
              status
              displayStatus
              deliveredAt
              inTransitAt
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { query: `name:${searchName}` });
  const node = data?.orders?.edges?.[0]?.node;
  if (!node) return null;
  const fallback = extractIrisAccountShopifyGraphqlFallbackOrder(node);
  if (!fallback) return null;
  return normalizeIrisAccountOrderNameKey(fallback.order_name) === normalizeIrisAccountOrderNameKey(expectedName)
    ? fallback
    : null;
};

const loadIrisAccountShopifyRestOrderFallback = async (
  lookupName: string,
  expectedName: string
): Promise<IrisAccountShopifyOrderFallback | null> => {
  const url = new URL(`https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/orders.json`);
  url.searchParams.set("status", "any");
  url.searchParams.set("limit", "1");
  url.searchParams.set("name", lookupName);
  url.searchParams.set(
    "fields",
    [
      "id",
      "admin_graphql_api_id",
      "name",
      "order_number",
      "email",
      "contact_email",
      "customer",
      "financial_status",
      "fulfillment_status",
      "currency",
      "current_total_price",
      "total_price",
      "processed_at",
      "created_at",
      "updated_at",
      "line_items",
      "fulfillments"
    ].join(",")
  );
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": env.shopifyAdminToken,
      Accept: "application/json"
    }
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { orders?: Array<Record<string, unknown>> };
  const fallback = data.orders?.[0] ? extractIrisAccountShopifyFallbackOrder(data.orders[0]) : null;
  if (!fallback) return null;
  return normalizeIrisAccountOrderNameKey(fallback.order_name) === normalizeIrisAccountOrderNameKey(expectedName)
    ? fallback
    : null;
};

const loadIrisAccountShopifyOrderFallbacksByName = async (
  orderNames: string[]
): Promise<Map<string, IrisAccountShopifyOrderFallback>> => {
  const fallbacks = new Map<string, IrisAccountShopifyOrderFallback>();
  const uniqueNames = Array.from(
    new Set(
      orderNames
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 25);

  for (const orderName of uniqueNames) {
    const lookupName = orderName.startsWith("#") ? orderName : `#${orderName}`;
    const searchName = normalizeIrisAccountOrderNameKey(lookupName);
    let graphqlFallback: IrisAccountShopifyOrderFallback | null = null;
    const graphqlQueries = Array.from(new Set([searchName, lookupName, `"${searchName}"`].filter(Boolean)));
    for (const queryName of graphqlQueries) {
      try {
        graphqlFallback = await loadIrisAccountShopifyGraphqlOrderFallback(queryName, lookupName);
      } catch {
        graphqlFallback = null;
      }
      if (graphqlFallback) break;
    }
    let restFallback: IrisAccountShopifyOrderFallback | null = null;
    if (!graphqlFallback || !hasSpecificIrisAccountFulfillmentStatus(graphqlFallback.fulfillment_status)) {
      const restNames = Array.from(new Set([searchName, lookupName].filter(Boolean)));
      for (const restName of restNames) {
        try {
          restFallback = await loadIrisAccountShopifyRestOrderFallback(restName, lookupName);
        } catch {
          restFallback = null;
        }
        if (restFallback) break;
      }
    }
    const fallback = mergeIrisAccountShopifyOrderFallbacks(graphqlFallback, restFallback);
    if (!fallback) continue;
    const keys = collectOrderLookupKeys({
      shopify_order_id: fallback.shopify_order_id,
      order_name: fallback.order_name,
      order_number: fallback.order_number
    });
    keys.push(
      normalizeOrderLookupKey(orderName),
      normalizeIrisAccountOrderNameKey(orderName),
      normalizeOrderLookupKey(lookupName),
      normalizeIrisAccountOrderNameKey(lookupName)
    );
    for (const key of keys.filter(Boolean)) {
      fallbacks.set(key, fallback);
    }
  }

  return fallbacks;
};

const loadIrisAccountOrders = async (email: string): Promise<IrisAccountOrderView[]> => {
  const normalizedEmail = normalizeEmail(email);
  const assignedArtworks = await prisma.artwork.findMany({
    where: {
      assigned_order_id: { not: null },
      assigned_customer_email: { equals: normalizedEmail, mode: "insensitive" },
      status: { in: ["assigned", "activated", "shopify_failed"] }
    },
    orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
    include: {
      collection: {
        select: {
          slug: true,
          name: true,
          edition_size: true
        }
      }
    },
    take: 200
  });
  const assignedIrisIds = assignedArtworks.map((item) => item.iris_id);
  const assignedEvents = assignedIrisIds.length
    ? await prisma.event.findMany({
        where: { iris_id: { in: assignedIrisIds }, type: "assigned" },
        orderBy: { created_at: "desc" }
      })
    : [];
  const assignedEventByIrisId = new Map<string, (typeof assignedEvents)[number]>();
  for (const event of assignedEvents) {
    if (!assignedEventByIrisId.has(event.iris_id)) {
      assignedEventByIrisId.set(event.iris_id, event);
    }
  }
  let pendingTransferIrisIds = new Set<string>();
  if (assignedIrisIds.length) {
    try {
      const pendingTransfers = await prisma.ownershipTransfer.findMany({
        where: {
          iris_id: { in: assignedIrisIds },
          status: "pending",
          expires_at: { gt: new Date() }
        },
        select: { iris_id: true }
      });
      pendingTransferIrisIds = new Set(pendingTransfers.map((transfer) => transfer.iris_id));
    } catch {
      pendingTransferIrisIds = new Set();
    }
  }
  const artworkViews = assignedArtworks.map((item) => ({
    iris_id: item.iris_id,
    display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
    image_url: item.image_url,
    rarity_code: item.rarity_code,
    weight_grams: item.weight_grams,
    status: item.status,
    activated_at: item.activated_at,
    transfer_pending: pendingTransferIrisIds.has(item.iris_id)
  }));
  const artworkByOrderKey = new Map<string, IrisAccountOrderArtworkView[]>();
  for (const item of assignedArtworks) {
    const key = normalizeOrderLookupKey(item.assigned_order_id);
    if (!key) continue;
    const display = artworkViews.find((view) => view.iris_id === item.iris_id);
    if (!display) continue;
    const list = artworkByOrderKey.get(key) ?? [];
    list.push(display);
    artworkByOrderKey.set(key, list);
  }

  let persistedOrders: Array<{
    id: string;
    shopify_order_id: string;
    order_name: string | null;
    order_number: string | null;
    email: string | null;
    financial_status: string | null;
    fulfillment_status: string | null;
    currency: string | null;
    total_price_cents: number | null;
    processed_at: Date | null;
    created_at_shopify: Date | null;
    updated_at_shopify: Date | null;
    created_at: Date;
    items: Array<{
      title: string | null;
      variant_title: string | null;
      quantity: number;
      price_cents: number | null;
    }>;
  }> = [];
  try {
    persistedOrders = await prisma.shopifyOrder.findMany({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      include: {
        items: {
          select: {
            title: true,
            variant_title: true,
            quantity: true,
            price_cents: true
          },
          orderBy: { created_at: "asc" }
        }
      },
      orderBy: [{ created_at_shopify: "desc" }, { created_at: "desc" }],
      take: 50
    });
  } catch {
    persistedOrders = [];
  }

  const shopifyFallbacks = await loadIrisAccountShopifyOrderFallbacksByName([
    ...persistedOrders.flatMap((order) => [
      order.order_name,
      order.order_number ? `#${order.order_number}` : null
    ]),
    ...assignedArtworks.map((item) => item.assigned_order_id)
  ].filter((value): value is string => Boolean(value)));

  const claimedLegacyKeys = new Set<string>();
  const orders = persistedOrders.map<IrisAccountOrderView>((order) => {
    const lookupKeys = collectOrderLookupKeys(order);
    const artworks = lookupKeys.flatMap((key) => artworkByOrderKey.get(key) ?? []);
    const shopifyFallback = lookupKeys.map((key) => shopifyFallbacks.get(key)).find(Boolean);
    lookupKeys.forEach((key) => claimedLegacyKeys.add(key));
    return {
      key: `shopify:${order.id}`,
      source: "shopify",
      shopify_order_id: shopifyFallback?.shopify_order_id ?? order.shopify_order_id,
      order_name: shopifyFallback?.order_name ?? order.order_name,
      order_number: shopifyFallback?.order_number ?? order.order_number,
      order_date: shopifyFallback?.order_date ?? order.created_at_shopify ?? order.processed_at ?? order.updated_at_shopify,
      email: shopifyFallback?.email ?? order.email,
      financial_status: shopifyFallback?.financial_status ?? order.financial_status,
      fulfillment_status: shopifyFallback?.fulfillment_status ?? order.fulfillment_status,
      currency: shopifyFallback?.currency ?? order.currency,
      total_price_cents: shopifyFallback?.total_price_cents ?? order.total_price_cents,
      items: shopifyFallback?.items.length ? shopifyFallback.items : order.items,
      artworks: Array.from(new Map(artworks.map((item) => [item.iris_id, item])).values())
    };
  });

  const legacyGroups = new Map<string, typeof assignedArtworks>();
  for (const item of assignedArtworks) {
    const key = normalizeOrderLookupKey(item.assigned_order_id);
    if (!key || claimedLegacyKeys.has(key)) continue;
    const group = legacyGroups.get(key) ?? [];
    group.push(item);
    legacyGroups.set(key, group);
  }
  for (const [key, group] of legacyGroups) {
    const first = group[0];
    const firstEvent = first ? assignedEventByIrisId.get(first.iris_id) : null;
    const shopifyFallback = shopifyFallbacks.get(key);
    const orderDate = firstEvent ? extractAssignedEventOrderDate(firstEvent) : first?.updated_at ?? null;
    orders.push({
      key: `legacy:${key}`,
      source: "legacy",
      shopify_order_id: shopifyFallback?.shopify_order_id ?? null,
      order_name: shopifyFallback?.order_name ?? first?.assigned_order_id ?? null,
      order_number: shopifyFallback?.order_number ?? first?.assigned_order_id?.replace(/^#/, "") ?? null,
      order_date: shopifyFallback?.order_date ?? orderDate,
      email: shopifyFallback?.email ?? normalizedEmail,
      financial_status: shopifyFallback?.financial_status ?? "paid",
      fulfillment_status: shopifyFallback?.fulfillment_status ?? null,
      currency: shopifyFallback?.currency ?? null,
      total_price_cents: shopifyFallback?.total_price_cents ?? null,
      items: shopifyFallback?.items ?? [],
      artworks: group.map((item) => ({
        iris_id: item.iris_id,
        display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        weight_grams: item.weight_grams,
        status: item.status,
        activated_at: item.activated_at,
        transfer_pending: pendingTransferIrisIds.has(item.iris_id)
      }))
    });
  }

  return orders.sort((a, b) => {
    const aTime = a.order_date ? a.order_date.getTime() : 0;
    const bTime = b.order_date ? b.order_date.getTime() : 0;
    return bTime - aTime;
  });
};

const buildAdminDetailHtml = (item: {
  iris_id: string;
  display_iris_id: string;
  status: string;
  rarity_code: string | null;
  weight_grams: number | null;
  assigned_order_id: string | null;
  assigned_customer_email: string | null;
  owner_email: string | null;
  activated_at: Date | null;
  order_date: Date | null;
  image_url: string | null;
  pin_code: string | null;
  activation_token: string | null;
  previous_iris_id: string | null;
  next_iris_id: string | null;
}) => {
  const displayId = item.display_iris_id.toUpperCase().startsWith("IRIS-")
    ? item.display_iris_id.replace(/^IRIS-/i, "#")
    : item.display_iris_id;
  const activationToken = item.activation_token ? item.activation_token : null;
  const activationLink = activationToken
    ? `${env.baseStorefrontUrl}/pages/activate?token=${activationToken}`
    : `${env.baseStorefrontUrl}/pages/activate?iris=${item.iris_id}`;
  const navButton = (label: string, targetIrisId: string | null) =>
    targetIrisId
      ? `<a class="btn secondary" href="/admin/iris/${encodeURIComponent(targetIrisId)}" style="width:34px;height:28px;padding:0;font-size:14px;">${label}</a>`
      : `<span class="btn secondary" style="width:34px;height:28px;padding:0;font-size:14px;opacity:.35;pointer-events:none;">${label}</span>`;
  const imageBox = item.image_url
    ? `<img src="${item.image_url}" alt="${item.iris_id}" />`
    : `<div class="muted">Upload Image</div>`;
  const body = `
    <div class="passport-title">IRIS Passport</div>
    <div class="title-row" style="justify-content:center;margin-bottom:18px;">
      <form class="search" method="GET" action="/admin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by IRIS-####, order id or owner email" />
      </form>
    </div>
    <div class="card passport" style="max-width:760px;margin:0 auto;">
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;">
          <h2 style="margin:0;">IRIS ${displayId}</h2>
          <div style="display:flex;gap:8px;">
            ${navButton("&lt;", item.previous_iris_id)}
            ${navButton("&gt;", item.next_iris_id)}
          </div>
        </div>
        <dl>
          <dt>Status</dt><dd>${statusPill(item.status)}</dd>
          <dt>Weight (g)</dt>
          <dd>
            <form method="POST" action="/admin/iris/weight" style="display:flex;gap:8px;align-items:center;">
              <input type="hidden" name="iris_id" value="${item.iris_id}" />
              <input name="weight_grams" type="number" step="0.01" min="0" value="${item.weight_grams ?? ""}" style="width:120px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;" />
              <button class="btn secondary" type="submit">Save</button>
            </form>
          </dd>
          <dt>Rarity</dt><dd>${item.rarity_code ?? "-"}</dd>
          <dt>Pin</dt><dd>${item.pin_code ?? "-"}</dd>
          <dt>Activation Link</dt>
          <dd>
            <div class="copy-row">
              <input class="copy-input" type="text" readonly value="${activationLink}" />
              <button class="btn secondary copy-btn" type="button" data-copy-link="${activationLink}" aria-label="Copy activation link">
                Copy link
              </button>
            </div>
          </dd>
          <dt>Order Number</dt><dd>${item.assigned_order_id ?? "-"}</dd>
          <dt>Order Date</dt><dd>${item.order_date ? item.order_date.toISOString().slice(0, 10) : "-"}</dd>
          <dt>Activation Date</dt><dd>${item.activated_at ? new Date(item.activated_at).toISOString().slice(0, 10) : "-"}</dd>
          <dt>Buyer</dt><dd>${item.assigned_customer_email ?? "-"}</dd>
          <dt>Owner</dt><dd>${item.owner_email ?? "-"}</dd>
        </dl>
        <div style="margin-top:16px;">
          <a class="btn primary" href="/admin">Back</a>
        </div>
      </div>
      <div>
        <div class="image-box">
          ${imageBox}
        </div>
        <form class="upload-form" style="margin-top:12px;justify-content:center;" method="POST" action="/admin/iris/upload" enctype="multipart/form-data">
          <input type="hidden" name="iris_id" value="${item.iris_id}" />
          <input class="file-input" id="file-detail-${item.iris_id}" type="file" name="image" accept="image/*" required />
          <label class="file-link" for="file-detail-${item.iris_id}">Choose File</label>
          <span class="file-name" data-file-name hidden></span>
          <button class="file-clear" type="button" data-file-clear hidden>×</button>
          <button class="btn primary" type="submit" data-upload-btn hidden>Upload</button>
        </form>
      </div>
    </div>
  `;
  return buildAdminShell(`IRIS ${item.iris_id}`, body, "", "all-iris");
};

const extractCustomerEmail = (order: Record<string, unknown>): string | null => {
  const email = order.email;
  if (typeof email === "string" && email.trim()) {
    return normalizeEmail(email);
  }
  const customer = order.customer as Record<string, unknown> | undefined;
  const customerEmail = customer?.email;
  if (typeof customerEmail === "string" && customerEmail.trim()) {
    return normalizeEmail(customerEmail);
  }
  return null;
};

const readShopifyString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const parseShopifyMoneyCents = (value: unknown): number | null => {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(raw) ? Math.round(raw * 100) : null;
};

const buildOrderLookupValues = (...values: Array<string | null | undefined>): string[] => {
  const variants = new Set<string>();
  for (const value of values) {
    const clean = value?.trim();
    if (!clean) continue;
    variants.add(clean);
    if (clean.startsWith("#") && clean.slice(1)) {
      variants.add(clean.slice(1));
    } else if (/^\d+$/.test(clean)) {
      variants.add(`#${clean}`);
    }
  }
  return Array.from(variants);
};

const shouldAssignForShopifyOrderWebhook = (topic: string, order: Record<string, unknown>): boolean => {
  const normalizedTopic = topic.toLowerCase();
  if (normalizedTopic.includes("orders/paid")) {
    return true;
  }

  const financialStatus = readShopifyString(order.financial_status)?.toLowerCase();
  const displayFinancialStatus = readShopifyString(order.displayFinancialStatus)?.toLowerCase();
  return financialStatus === "paid" || financialStatus === "partially_refunded" || displayFinancialStatus === "paid";
};

const toPrismaJson = (value: unknown): any => {
  if (value == null) return Prisma.JsonNull;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Prisma.JsonNull;
  }
};

const extractShopifyOrderLineItems = (order: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(order.line_items) ? (order.line_items as Array<Record<string, unknown>>) : [];

const extractShopifyFulfillmentStatus = (order: Record<string, unknown>): string | null => {
  const fulfillments = Array.isArray(order.fulfillments) ? (order.fulfillments as Array<Record<string, unknown>>) : [];
  for (const fulfillment of fulfillments) {
    if (parseDateValue(fulfillment.delivered_at ?? fulfillment.deliveredAt)) return "delivered";
  }
  for (const fulfillment of fulfillments) {
    if (parseDateValue(fulfillment.in_transit_at ?? fulfillment.inTransitAt)) return "in_transit";
  }
  for (const fulfillment of fulfillments) {
    const shipmentStatus = readShopifyString(fulfillment.shipment_status);
    if (shipmentStatus) return shipmentStatus;
  }
  const direct = readShopifyString(order.fulfillment_status);
  if (direct) return direct;

  for (const fulfillment of fulfillments) {
    const status = readShopifyString(fulfillment.status);
    if (status) return status;
  }
  return null;
};

const saveShopifyOrderSnapshot = async (order: Record<string, unknown>) => {
  const shopifyOrderId =
    readShopifyString(order.id) ?? readShopifyString(order.admin_graphql_api_id) ?? readShopifyString(order.name);
  if (!shopifyOrderId) {
    throw new Error("shopify_order_id_missing");
  }

  const currency = readShopifyString(order.currency) ?? "USD";
  const fulfillmentStatus = extractShopifyFulfillmentStatus(order);
  const lineItems = extractShopifyOrderLineItems(order).map((item) => {
    const rawQuantity = Number(item.quantity ?? 1);
    return {
      shopify_line_item_id: readShopifyString(item.id),
      product_id: readShopifyString(item.product_id),
      variant_id: readShopifyString(item.variant_id),
      title: readShopifyString(item.title) ?? readShopifyString(item.name),
      variant_title: readShopifyString(item.variant_title),
      sku: readShopifyString(item.sku),
      quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.floor(rawQuantity) : 1,
      price_cents: parseShopifyMoneyCents(item.price),
      total_discount_cents: parseShopifyMoneyCents(item.total_discount),
      currency,
      properties_json: toPrismaJson(item.properties)
    };
  });

  await prisma.shopifyOrder.upsert({
    where: { shopify_order_id: shopifyOrderId },
    create: {
      shopify_order_id: shopifyOrderId,
      order_name: readShopifyString(order.name),
      order_number: readShopifyString(order.order_number),
      email: extractCustomerEmail(order),
      financial_status: readShopifyString(order.financial_status),
      fulfillment_status: fulfillmentStatus,
      currency,
      subtotal_price_cents: parseShopifyMoneyCents(order.current_subtotal_price ?? order.subtotal_price),
      total_price_cents: parseShopifyMoneyCents(order.current_total_price ?? order.total_price),
      total_tax_cents: parseShopifyMoneyCents(order.current_total_tax ?? order.total_tax),
      processed_at: parseDateValue(order.processed_at),
      created_at_shopify: parseDateValue(order.created_at),
      updated_at_shopify: parseDateValue(order.updated_at),
      raw_json: toPrismaJson(order),
      items: { create: lineItems }
    },
    update: {
      order_name: readShopifyString(order.name),
      order_number: readShopifyString(order.order_number),
      email: extractCustomerEmail(order),
      financial_status: readShopifyString(order.financial_status),
      fulfillment_status: fulfillmentStatus,
      currency,
      subtotal_price_cents: parseShopifyMoneyCents(order.current_subtotal_price ?? order.subtotal_price),
      total_price_cents: parseShopifyMoneyCents(order.current_total_price ?? order.total_price),
      total_tax_cents: parseShopifyMoneyCents(order.current_total_tax ?? order.total_tax),
      processed_at: parseDateValue(order.processed_at),
      created_at_shopify: parseDateValue(order.created_at),
      updated_at_shopify: parseDateValue(order.updated_at),
      raw_json: toPrismaJson(order),
      items: {
        deleteMany: {},
        create: lineItems
      }
    }
  });
};

const shopifyGraphQL = async (query: string, variables: Record<string, unknown>) => {
  const url = `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": env.shopifyAdminToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }
  const json = JSON.parse(text) as { errors?: unknown; data?: unknown };
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as Record<string, any>;
};

const shopifyFindCustomerIdByEmail = async (email: string): Promise<string | null> => {
  const q = `
    query ($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id email } }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { q: `email:${email}` });
  const edge = data?.customers?.edges?.[0];
  return edge?.node?.id ?? null;
};

const shopifyCreateCustomer = async (email: string): Promise<string> => {
  const m = `
    mutation ($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(m, { input: { email } });
  const errs = data?.customerCreate?.userErrors;
  if (errs && errs.length) {
    throw new Error(`customerCreate: ${JSON.stringify(errs)}`);
  }
  return data.customerCreate.customer.id as string;
};

const shopifyGetLegacyId = async (customerId: string): Promise<number | null> => {
  const q = `query ($id: ID!) { customer(id: $id) { legacyResourceId } }`;
  const data = await shopifyGraphQL(q, { id: customerId });
  return data?.customer?.legacyResourceId ?? null;
};

const shopifySendInviteBestEffort = async (legacyId: number): Promise<void> => {
  const url = `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/customers/${legacyId}/send_invite.json`;
  await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": env.shopifyAdminToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ customer_invite: {} })
  });
};

const ensureShopifyCustomerInvite = async (email: string): Promise<void> => {
  const existingId = await shopifyFindCustomerIdByEmail(email);
  if (existingId) {
    return;
  }
  const createdId = await shopifyCreateCustomer(email);
  const legacyId = await shopifyGetLegacyId(createdId);
  if (!legacyId) return;
  try {
    await shopifySendInviteBestEffort(legacyId);
  } catch {
    // ignore invite failures
  }
};

const recordShopifyOwnership = async (_order: Record<string, unknown>, _irisId: string): Promise<void> => {
  // Placeholder for future Shopify updates (metafields/tags).
};

const generatePin = (): string => {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, "0");
};

type CollectionLookupInput = {
  collectionSlug?: string | null;
  collectionId?: string | null;
  productId?: string | null;
  productHandle?: string | null;
};

const CORE_COLLECTION_SLUG = "iris-the-unseen-edition";
const CORE_COLLECTION_ALIASES = new Set([
  CORE_COLLECTION_SLUG,
  "iris-collection",
  "iris"
]);

type IrisCollectionDisplayMeta = {
  slug?: string | null;
  edition_size?: number | null;
} | null | undefined;

const isCoreCollectionAlias = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return CORE_COLLECTION_ALIASES.has(normalizeCollectionSlug(value));
};

const isCoreProductIdentity = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const slug = normalizeCollectionSlug(value);
  return (
    CORE_COLLECTION_ALIASES.has(slug) ||
    slug === `${CORE_COLLECTION_SLUG}-default-title` ||
    slug.startsWith(`${CORE_COLLECTION_SLUG}-`)
  );
};

const displayWidthForCollection = (collection: IrisCollectionDisplayMeta): number | null => {
  const editionSize = collection?.edition_size ?? null;
  if (!editionSize || !Number.isFinite(editionSize) || editionSize <= 0) {
    return null;
  }
  return Math.max(3, String(editionSize).length);
};

const formatDisplayIrisId = (irisId: string, collection: IrisCollectionDisplayMeta): string => {
  const clean = sanitizeIrisId(irisId);
  if (clean.toUpperCase().startsWith("IRIS-")) {
    return clean;
  }

  const match = clean.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    return clean;
  }

  const width = displayWidthForCollection(collection);
  if (!width) {
    return clean;
  }

  const numericValue = Number(match[2]);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return clean;
  }

  return `${match[1]}-${String(numericValue).padStart(width, "0")}`;
};

const resolveCollection = async (input: CollectionLookupInput) => {
  const where: Prisma.CollectionWhereInput[] = [];
  if (input.collectionId) {
    where.push({ id: input.collectionId });
  }
  if (input.collectionSlug) {
    where.push({ slug: normalizeCollectionSlug(input.collectionSlug) });
  }
  if (input.productId) {
    where.push({ shopify_product_id: input.productId });
  }
  if (input.productHandle) {
    where.push({ shopify_handle: input.productHandle.trim() });
  }

  if (where.length === 0) {
    return null;
  }

  return prisma.collection.findFirst({
    where: where.length === 1 ? where[0] : { OR: where }
  });
};

type ArtworkPoolScope =
  | { mode: "any" }
  | { mode: "core" }
  | { mode: "collection"; collectionId: string };

const pickAvailableArtwork = async (
  tx: Prisma.TransactionClient,
  scope: ArtworkPoolScope
): Promise<string | null> => {
  if (scope.mode === "collection") {
    const rows = await tx.$queryRaw<{ iris_id: string }[]>`
      SELECT "iris_id" FROM "Artwork"
      WHERE "status" = 'available' AND "collection_id" = ${scope.collectionId}
      ORDER BY random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    return rows[0]?.iris_id ?? null;
  }

  if (scope.mode === "core") {
    const rows = await tx.$queryRaw<{ iris_id: string }[]>`
      SELECT "iris_id" FROM "Artwork"
      WHERE "status" = 'available' AND "collection_id" IS NULL
      ORDER BY random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    return rows[0]?.iris_id ?? null;
  }

  const rows = await tx.$queryRaw<{ iris_id: string }[]>`
    SELECT "iris_id" FROM "Artwork"
    WHERE "status" = 'available'
    ORDER BY random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;
  return rows[0]?.iris_id ?? null;
};

const releaseExpiredReservations = async (app: FastifyInstance): Promise<void> => {
  const now = new Date();
  const expired = await prisma.reservation.findMany({
    where: {
      status: "active",
      expires_at: { lt: now }
    },
    take: 200
  });

  if (expired.length === 0) {
    return;
  }

  for (const reservation of expired) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.reservation.update({
          where: { token: reservation.token },
          data: { status: "expired" }
        });

        const artwork = await tx.artwork.updateMany({
          where: {
            iris_id: reservation.iris_id,
            status: "reserved"
          },
          data: { status: "available" }
        });

        await tx.event.create({
          data: {
            iris_id: reservation.iris_id,
            type: "reservation_expired",
            actor: "system",
            payload_json: {
              reservation_token: reservation.token,
              artwork_released: artwork.count > 0
            }
          }
        });
      });
    } catch (error) {
      app.log.error({ err: error, reservationToken: reservation.token }, "Failed to release reservation");
    }
  }
};

export const createServer = async (): Promise<FastifyInstance> => {
  const app = fastify({ logger: true });
  const sendJson = (reply: any, status: number, payload: unknown) =>
    reply.code(status).type("application/json; charset=utf-8").send(payload);

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      if (!body || (body as Buffer).length === 0) {
        done(null, {});
        return;
      }
      try {
        const parsed = JSON.parse((body as Buffer).toString("utf8"));
        done(null, parsed);
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      const text = body ? (body as Buffer).toString("utf8") : "";
      done(null, querystring.parse(text));
    }
  );

  app.post("/apps/iris/reserve-random", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const query = (req.query as Record<string, unknown> | null) ?? {};
    const collectionSlug =
      typeof body.collection_slug === "string"
        ? body.collection_slug
        : typeof body.collectionSlug === "string"
          ? body.collectionSlug
          : typeof query.collection_slug === "string"
            ? query.collection_slug
            : typeof query.collectionSlug === "string"
              ? query.collectionSlug
              : null;
    const collectionId =
      typeof body.collection_id === "string"
        ? body.collection_id
        : typeof body.collectionId === "string"
          ? body.collectionId
          : typeof query.collection_id === "string"
            ? query.collection_id
            : typeof query.collectionId === "string"
              ? query.collectionId
              : null;
    const productId =
      typeof body.product_id === "string"
        ? body.product_id
        : typeof body.productId === "string"
          ? body.productId
          : typeof query.product_id === "string"
            ? query.product_id
            : typeof query.productId === "string"
              ? query.productId
              : null;
    const productHandle =
      typeof body.product_handle === "string"
        ? body.product_handle
        : typeof body.productHandle === "string"
          ? body.productHandle
          : typeof query.product_handle === "string"
            ? query.product_handle
            : typeof query.productHandle === "string"
              ? query.productHandle
              : null;

    const collection = await resolveCollection({
      collectionId,
      collectionSlug,
      productId,
      productHandle
    });
    const coreCollectionRequested = [
      collectionSlug,
      productHandle
    ].some((value) => isCoreCollectionAlias(value));

    if ((collectionSlug || collectionId || productId || productHandle) && !collection && !coreCollectionRequested) {
      sendJson(reply, 404, { error: "collection_not_found" });
      return;
    }

    const reservation = await prisma.$transaction(async (tx) => {
      const poolScope: ArtworkPoolScope = collection
        ? { mode: "collection", collectionId: collection.id }
        : coreCollectionRequested
          ? { mode: "core" }
          : { mode: "any" };
      const irisId = await pickAvailableArtwork(tx, poolScope);
      if (!irisId) {
        return null;
      }

      const expiresAt = new Date(Date.now() + env.reservationTtlMinutes * 60 * 1000);

      await tx.artwork.update({
        where: { iris_id: irisId },
        data: { status: "reserved" }
      });

      const reservationRecord = await tx.reservation.create({
        data: {
          iris_id: irisId,
          status: "active",
          expires_at: expiresAt
        }
      });

      await tx.event.create({
        data: {
          iris_id: irisId,
          type: "reserved",
          actor: "system",
          payload_json: {
            reservation_token: reservationRecord.token,
            expires_at: expiresAt.toISOString()
          }
        }
      });

      return reservationRecord;
    });

    if (!reservation) {
      sendJson(reply, 409, {
        error: "no_available_artwork",
        ...(collection ? { collection: { slug: collection.slug, name: collection.name } } : {})
      });
      return;
    }

    sendJson(reply, 200, {
      reservationToken: reservation.token,
      ...(collection ? { collection: { slug: collection.slug, name: collection.name } } : {})
    });
  });

  app.post("/webhooks/shopify/orders-paid", async (req, reply) => {
    const rawBody = req.rawBody;
    if (!rawBody) {
      reply.code(400).send({ error: "missing_raw_body" });
      return;
    }

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const webhookIdHeader = req.headers["x-shopify-webhook-id"];
    const topicHeader = req.headers["x-shopify-topic"] ?? "orders/paid";

    if (typeof hmacHeader !== "string" || !hmacHeader) {
      reply.code(401).send({ error: "missing_hmac" });
      return;
    }

    if (typeof webhookIdHeader !== "string" || !webhookIdHeader) {
      reply.code(400).send({ error: "missing_webhook_id" });
      return;
    }

    const isValid = verifyShopifyHmac(rawBody, env.shopifyWebhookSecret, hmacHeader);
    if (!isValid) {
      reply.code(401).send({ error: "invalid_hmac" });
      return;
    }

    try {
      await prisma.webhookReceipt.create({
        data: {
          topic: String(topicHeader),
          shopify_webhook_id: webhookIdHeader
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        reply.send({ status: "duplicate" });
        return;
      }
      req.log.error({ err: error }, "Failed to write webhook receipt");
      reply.code(500).send({ error: "webhook_receipt_failed" });
      return;
    }

    const order = req.body as Record<string, unknown>;
    const lineItems = parseShopifyLineItems(order);
    const reservationTokens = lineItems.flatMap((item) => item.reservationTokens);

    const orderId = order.id ? String(order.id) : null;
    const orderName = typeof order.name === "string" ? order.name : null;
    const orderNumber =
      typeof order.order_number === "number" || typeof order.order_number === "string"
        ? String(order.order_number)
        : null;
    const orderNumberDisplay = orderName ?? orderNumber ?? orderId;
    const orderLookupValues = buildOrderLookupValues(orderName, orderNumber, orderId, orderNumberDisplay);
    const customerEmail = extractCustomerEmail(order);
    const orderCreatedAt = extractShopifyOrderDate(order);
    const orderCreatedAtIso = orderCreatedAt ? orderCreatedAt.toISOString() : null;
    const failed: Array<{ token: string; error: string }> = [];
    const assignedForOrderEmail = new Set<string>();
    const collectionLookupCache = new Map<string, Awaited<ReturnType<typeof resolveCollection>>>();

    try {
      await saveShopifyOrderSnapshot(order);
    } catch (error) {
      req.log.error({ err: error, orderId, orderNumber: orderNumberDisplay }, "Shopify order snapshot failed");
    }

    if (!shouldAssignForShopifyOrderWebhook(String(topicHeader), order)) {
      reply.send({ status: "snapshot_only", reason: "order_not_paid" });
      return;
    }

    const resolveLineItemCollection = async (
      productId: string | null,
      productHandle: string | null,
      collectionSlug?: string | null
    ) => {
      const cacheKey = `${collectionSlug ?? ""}|${productId ?? ""}|${productHandle ?? ""}`;
      if (collectionLookupCache.has(cacheKey)) {
        return collectionLookupCache.get(cacheKey) ?? null;
      }
      const collection = await resolveCollection({ productId, productHandle, collectionSlug });
      collectionLookupCache.set(cacheKey, collection);
      return collection;
    };

    const confirmReservation = async (reservationToken: string) => {
      let assignedIrisId: string | null = null;
      let generatedPin: string | null = null;

      await prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findUnique({
          where: { token: reservationToken }
        });

        if (!reservation || reservation.status !== "active") {
          throw new Error("reservation_not_active");
        }

        if (reservation.expires_at < new Date()) {
          await tx.reservation.update({
            where: { token: reservationToken },
            data: { status: "expired" }
          });
          const artwork = await tx.artwork.updateMany({
            where: {
              iris_id: reservation.iris_id,
              status: "reserved"
            },
            data: { status: "available" }
          });
          await tx.event.create({
            data: {
              iris_id: reservation.iris_id,
              type: "reservation_expired",
              actor: "shopify",
              payload_json: {
                reservation_token: reservationToken,
                order_id: orderId,
                order_number: orderNumberDisplay,
                order_created_at: orderCreatedAtIso,
                artwork_released: artwork.count > 0,
                source: "orders_paid"
              }
            }
          });
          throw new Error("reservation_expired");
        }

        await tx.reservation.update({
          where: { token: reservationToken },
          data: { status: "confirmed" }
        });

        const artwork = await tx.artwork.findUnique({
          where: { iris_id: reservation.iris_id }
        });

        const pinCode = artwork?.pin_code ?? generatePin();
        const activationToken = artwork?.activation_token ?? generateActivationToken();
        generatedPin = artwork?.pin_code ? null : pinCode;

        await tx.artwork.update({
          where: { iris_id: reservation.iris_id },
          data: {
            status: "assigned",
            assigned_order_id: orderNumberDisplay,
            assigned_customer_email: customerEmail,
            pin_code: pinCode,
            pin_last4: pinCode.slice(-4),
            activation_token: activationToken,
            pin_attempts: 0,
            pin_locked_until: null
          }
        });

        await tx.event.create({
          data: {
            iris_id: reservation.iris_id,
            type: "assigned",
            actor: "shopify",
            payload_json: {
              reservation_token: reservationToken,
              order_id: orderId,
              order_number: orderNumberDisplay,
              order_created_at: orderCreatedAtIso,
              customer_email: customerEmail
            }
          }
        });

        if (generatedPin) {
          await tx.event.create({
            data: {
              iris_id: reservation.iris_id,
              type: "pin_generated",
              actor: "system",
              payload_json: {
                pin_last4: pinCode.slice(-4)
              }
            }
          });
        }

        assignedIrisId = reservation.iris_id;
      });

      if (assignedIrisId) {
        const irisId = assignedIrisId;
        assignedForOrderEmail.add(irisId);
        try {
          await recordShopifyOwnership(order, irisId);
        } catch (error) {
          req.log.error({ err: error, irisId }, "Shopify write failed");
          await prisma.$transaction(async (tx) => {
            await tx.artwork.update({
              where: { iris_id: irisId },
              data: { status: "shopify_failed" }
            });
            await tx.event.create({
              data: {
                iris_id: irisId,
                type: "SHOPIFY_ERROR",
                actor: "shopify",
                payload_json: {
                  reservation_token: reservationToken,
                  order_id: orderId,
                  error: error instanceof Error ? error.message : "unknown"
                }
              }
            });
          });
        }
      }
    };

    const assignFromPool = async (
      pool:
        | { kind: "collection"; collection: { id: string; slug: string; name: string } }
        | { kind: "core" },
      lineItem: (typeof lineItems)[number]
    ) => {
      let assignedIrisId: string | null = null;
      let generatedPin: string | null = null;

      await prisma.$transaction(async (tx) => {
        const irisId = await pickAvailableArtwork(
          tx,
          pool.kind === "collection"
            ? {
                mode: "collection",
                collectionId: pool.collection.id
              }
            : {
                mode: "core"
              }
        );
        if (!irisId) {
          throw new Error(
            pool.kind === "collection"
              ? `no_available_artwork:${pool.collection.slug}`
              : "no_available_artwork:core"
          );
        }

        const artwork = await tx.artwork.findUnique({
          where: { iris_id: irisId }
        });

        const pinCode = artwork?.pin_code ?? generatePin();
        const activationToken = artwork?.activation_token ?? generateActivationToken();
        generatedPin = artwork?.pin_code ? null : pinCode;

        await tx.artwork.update({
          where: { iris_id: irisId },
          data: {
            status: "assigned",
            assigned_order_id: orderNumberDisplay,
            assigned_customer_email: customerEmail,
            pin_code: pinCode,
            pin_last4: pinCode.slice(-4),
            activation_token: activationToken,
            pin_attempts: 0,
            pin_locked_until: null
          }
        });

        await tx.event.create({
          data: {
            iris_id: irisId,
            type: "assigned",
            actor: "shopify",
            payload_json: {
              order_id: orderId,
              order_number: orderNumberDisplay,
              order_created_at: orderCreatedAtIso,
              customer_email: customerEmail,
              collection_slug: pool.kind === "collection" ? pool.collection.slug : CORE_COLLECTION_SLUG,
              collection_name: pool.kind === "collection" ? pool.collection.name : "IRIS Collection",
              source: "product_mapping",
              shopify_product_id: lineItem.productId,
              shopify_handle: lineItem.handle,
              line_item_title: lineItem.title,
              line_item_name: lineItem.name,
              line_item_sku: lineItem.sku,
              line_item_variant_title: lineItem.variantTitle,
              line_item_iris_ids: lineItem.irisIds,
              line_item_collection_slugs: lineItem.collectionSlugs,
              core_collection: pool.kind === "core"
            }
          }
        });

        if (generatedPin) {
          await tx.event.create({
            data: {
              iris_id: irisId,
              type: "pin_generated",
              actor: "system",
              payload_json: {
                pin_last4: pinCode.slice(-4)
              }
            }
          });
        }

        assignedIrisId = irisId;
      });

      if (assignedIrisId) {
        assignedForOrderEmail.add(assignedIrisId);
        try {
          await recordShopifyOwnership(order, assignedIrisId);
        } catch (error) {
          req.log.error({ err: error, irisId: assignedIrisId }, "Shopify write failed");
          await prisma.$transaction(async (tx) => {
            await tx.artwork.update({
              where: { iris_id: assignedIrisId! },
              data: { status: "shopify_failed" }
            });
            await tx.event.create({
              data: {
                iris_id: assignedIrisId!,
                type: "SHOPIFY_ERROR",
                actor: "shopify",
                payload_json: {
                  order_id: orderId,
                  error: error instanceof Error ? error.message : "unknown",
                  source: "product_mapping"
                }
              }
            });
          });
        }
      }
    };

    type LineItemPool =
      | { kind: "collection"; collection: { id: string; slug: string; name: string } }
      | { kind: "core" }
      | { kind: "none" };

    const poolKey = (pool: LineItemPool): string =>
      pool.kind === "collection" ? `collection:${pool.collection.id}` : pool.kind;

    const countExistingAssignmentsForPool = async (pool: Exclude<LineItemPool, { kind: "none" }>) =>
      prisma.artwork.count({
        where: {
          assigned_order_id: { in: orderLookupValues },
          ...(pool.kind === "collection" ? { collection_id: pool.collection.id } : { collection_id: null })
        }
      });

    const resolveLineItemPool = async (item: {
      productId: string | null;
      handle: string | null;
      title: string | null;
      name: string | null;
      sku: string | null;
      variantTitle: string | null;
      quantity: number;
      irisIds: string[];
      collectionSlugs: string[];
      reservationTokens: string[];
    }): Promise<LineItemPool> => {
      for (const collectionSlug of item.collectionSlugs) {
        if (isCoreCollectionAlias(collectionSlug)) {
          return { kind: "core" };
        }
        const collection = await resolveLineItemCollection(null, null, collectionSlug);
        if (collection) {
          return { kind: "collection", collection };
        }
      }

      const collection = await resolveLineItemCollection(item.productId, item.handle);
      if (collection) {
        return { kind: "collection", collection };
      }
      if (
        isCoreCollectionAlias(item.handle) ||
        [item.handle, item.title, item.name, item.sku, item.variantTitle].some(isCoreProductIdentity)
      ) {
        return { kind: "core" };
      }

      for (const lineItemIrisId of item.irisIds) {
        const irisId = sanitizeIrisId(lineItemIrisId);
        if (irisId.toUpperCase().startsWith("IRIS-")) {
          return { kind: "core" };
        }
        const artwork = await prisma.artwork.findUnique({
          where: { iris_id: irisId },
          include: {
            collection: {
              select: {
                id: true,
                slug: true,
                name: true
              }
            }
          }
        });
        if (artwork?.collection) {
          return { kind: "collection", collection: artwork.collection };
        }
      }

      return { kind: "none" };
    };

    const relevantLineItems = [] as Array<{
      item: (typeof lineItems)[number];
      pool: LineItemPool;
    }>;

    for (const item of lineItems) {
      const pool = await resolveLineItemPool(item);
      if (item.reservationTokens.length === 0 && pool.kind === "none") {
        continue;
      }
      relevantLineItems.push({ item, pool });
    }

    if (reservationTokens.length === 0 && relevantLineItems.length === 0) {
      reply.code(400).send({ error: "missing_reservation_token" });
      return;
    }

    const desiredQuantityByPool = new Map<string, number>();

    try {
      for (const { item, pool } of relevantLineItems) {
        for (const token of item.reservationTokens) {
          try {
            await confirmReservation(token);
          } catch (error) {
            const message = error instanceof Error ? error.message : "unknown";
            if (message === "reservation_expired" || message === "reservation_not_active") {
              failed.push({ token, error: message });
              continue;
            }
            throw error;
          }
        }

        if (pool.kind === "none") {
          const unresolvedMissingCount = Math.max(0, item.quantity - item.reservationTokens.length);
          req.log.warn(
            {
              orderId,
              productId: item.productId,
              handle: item.handle,
              title: item.title,
              name: item.name,
              sku: item.sku,
              variantTitle: item.variantTitle,
              irisIds: item.irisIds,
              collectionSlugs: item.collectionSlugs,
              missingCount: unresolvedMissingCount
            },
            "Unable to recover missing reservation without a pool mapping"
          );
          continue;
        }

        const key = poolKey(pool);
        const desiredQuantity = (desiredQuantityByPool.get(key) ?? 0) + item.quantity;
        desiredQuantityByPool.set(key, desiredQuantity);
        const existingAssignments = await countExistingAssignmentsForPool(pool);
        const missingCount = Math.max(0, desiredQuantity - existingAssignments);
        if (missingCount === 0) {
          continue;
        }

        for (let index = 0; index < missingCount; index += 1) {
          await assignFromPool(pool, item);
        }
      }
    } catch (error) {
      req.log.error({ err: error }, "Failed to confirm reservation");
      reply.code(500).send({ error: "reservation_confirm_failed" });
      return;
    }

    if (failed.length > 0) {
      req.log.warn({ failed, orderId }, "Some reservations failed to confirm");
    }

    if (customerEmail && assignedForOrderEmail.size > 0) {
      try {
        const assignedItems = await prisma.artwork.findMany({
          where: {
            iris_id: {
              in: Array.from(assignedForOrderEmail)
            }
          },
          include: {
            collection: {
              select: {
                slug: true,
                edition_size: true
              }
            }
          },
          orderBy: [{ iris_id: "asc" }]
        });
        if (assignedItems.length === 0) {
          req.log.warn({ orderId, orderNumber: orderNumberDisplay }, "Order assignment email skipped with no items");
        } else {
          const emailResult = await sendOrderAssignmentEmailBestEffort({
            toEmail: customerEmail,
            orderNumber: orderNumberDisplay,
            items: assignedItems.map((item) => ({
              irisId: item.iris_id,
              displayIrisId: formatDisplayIrisId(item.iris_id, item.collection),
              status: item.status,
              imageUrl: item.image_url,
              rarityCode: item.rarity_code,
              weightGrams: item.weight_grams,
              activatedAt: item.activated_at
            }))
          });
          await prisma.event.createMany({
            data: assignedItems.map((item) => ({
              iris_id: item.iris_id,
              type: emailResult.sent ? "order_assignment_email_sent" : "order_assignment_email_skipped",
              actor: "system",
              payload_json: {
                order_id: orderId,
                order_number: orderNumberDisplay,
                customer_email: customerEmail,
                reason: emailResult.reason
              }
            }))
          });
          if (!emailResult.sent) {
            req.log.warn(
              { orderId, orderNumber: orderNumberDisplay, reason: emailResult.reason },
              "Order assignment email skipped"
            );
          }
        }
      } catch (error) {
        req.log.warn({ err: error, orderId, orderNumber: orderNumberDisplay }, "Order assignment email failed");
      }
    }

    reply.send({ status: failed.length ? "partial" : "ok", failedCount: failed.length });
  });

  app.get("/health", async (_req, reply) => {
    reply.send({ status: "ok" });
  });

  app.get("/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      reply.send({ status: "ok" });
    } catch (error) {
      reply.code(503).send({ status: "db_unavailable" });
    }
  });

  app.post("/activate", async (req, reply) => {
    const body = req.body as { iris_id?: string; pin?: string; actor_email?: string };
    if (!body?.iris_id || !body?.pin) {
      reply.code(400).send({ error: "missing_required_fields" });
      return;
    }

    try {
      const updated = await prisma.artwork.update({
        where: { iris_id: body.iris_id },
        data: {
          status: "activated",
          activated_at: new Date(),
          assigned_customer_email: body.actor_email ? body.actor_email : undefined
        }
      });

      await prisma.event.create({
        data: {
          iris_id: updated.iris_id,
          type: "activated",
          actor: body.actor_email ?? "system",
          payload_json: {
            actor_email: body.actor_email ?? null
          }
        }
      });

      reply.send({ status: "ok" });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        reply.code(404).send({ error: "iris_not_found" });
        return;
      }
      req.log.error({ err: error }, "Activation failed");
      reply.code(500).send({ error: "activation_failed" });
    }
  });

  const handleActivateVerify = async (req: any, reply: any) => {
    const body = req.body as {
      iris_id?: string;
      pin?: string;
      email?: string;
      token?: string;
      iris_account_session?: string;
      session?: string;
    };
    let irisId = body?.iris_id?.toUpperCase().trim() ?? "";
    let token = body?.token?.trim() ?? "";
    const tokenMatch = irisId.match(/^IRIS-\d{4}-(.+)$/i);
    if (tokenMatch) {
      irisId = irisId.slice(0, 9);
      if (!token) token = tokenMatch[1];
    }
    const pin = body?.pin?.trim();
    const submittedEmail = normalizeEmail(body?.email);
    const submittedSessionToken = readSingleValue(body?.iris_account_session || body?.session).trim();
    let irisAccountAuth: Awaited<ReturnType<typeof getIrisAccountAuth>> | null = null;
    try {
      irisAccountAuth = await getIrisAccountAuth(req, submittedSessionToken);
    } catch (error) {
      req.log.warn({ err: error }, "IRIS Account auth check skipped during activation");
    }
    const email = irisAccountAuth?.user.email ?? submittedEmail;

    if ((!irisId && !token) || !pin || !email) {
      sendJson(reply, 400, { error: "missing_required_fields" });
      return;
    }
    if (!isValidEmail(email)) {
      sendJson(reply, 400, { error: "invalid_email" });
      return;
    }

    const MAX_ATTEMPTS = 4;
    const LOCK_MINUTES = 60;

    try {
      let artwork = irisId
        ? await prisma.artwork.findUnique({
            where: { iris_id: irisId },
            include: {
              collection: {
                select: {
                  slug: true,
                  name: true,
                  edition_size: true
                }
              }
            }
          })
        : null;
      if (!artwork && token) {
        artwork = await prisma.artwork.findUnique({
          where: { activation_token: token },
          include: {
            collection: {
              select: {
                slug: true,
                name: true,
                edition_size: true
              }
            }
          }
        });
        if (artwork) {
          irisId = artwork.iris_id;
        }
      }
      if (!artwork) {
        sendJson(reply, 404, { error: "iris_not_found" });
        return;
      }

      if (artwork.status === "activated") {
        sendJson(reply, 409, { error: "already_activated" });
        return;
      }

      if (artwork.status !== "assigned") {
        sendJson(reply, 409, { error: "not_assigned" });
        return;
      }

      if (!artwork.pin_code) {
        sendJson(reply, 409, { error: "pin_not_set" });
        return;
      }

      if (artwork.activation_token) {
        if (!token || token !== artwork.activation_token) {
          sendJson(reply, 403, { error: "invalid_activation_link" });
          return;
        }
      }

      if (artwork.pin_locked_until && artwork.pin_locked_until > new Date()) {
        await prisma.event.create({
          data: {
            iris_id: irisId,
            type: "activation_blocked",
            actor: email,
            payload_json: {
              reason: "locked_until",
              locked_until: artwork.pin_locked_until
            }
          }
        });
        sendJson(reply, 429, { error: "too_many_attempts", retry_at: artwork.pin_locked_until });
        return;
      }

      if (artwork.pin_code !== pin) {
        const nextAttempts = (artwork.pin_attempts ?? 0) + 1;
        const lockUntil =
          nextAttempts >= MAX_ATTEMPTS
            ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
            : null;

        await prisma.$transaction(async (tx) => {
          await tx.artwork.update({
            where: { iris_id: irisId },
            data: {
              pin_attempts: nextAttempts,
              pin_locked_until: lockUntil
            }
          });
          await tx.event.create({
            data: {
              iris_id: irisId,
              type: lockUntil ? "activation_blocked" : "activation_failed",
              actor: email,
              payload_json: {
                reason: lockUntil ? "max_attempts" : "invalid_pin",
                attempts: nextAttempts,
                locked_until: lockUntil
              }
            }
          });
        });

        if (lockUntil) {
          sendJson(reply, 429, { error: "too_many_attempts", retry_at: lockUntil });
        } else {
          sendJson(reply, 401, { error: "invalid_pin" });
        }
        return;
      }

      const proofToken = artwork.proof_token ?? crypto.randomUUID();
      const activatedAt = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.artwork.update({
          where: { iris_id: irisId },
          data: {
            status: "activated",
            activated_at: activatedAt,
            owner_email: email,
            proof_token: proofToken,
            pin_attempts: 0,
            pin_locked_until: null
          }
        });
        await tx.event.create({
          data: {
            iris_id: irisId,
            type: "activated",
            actor: email,
            payload_json: {
              actor_email: email
            }
          }
        });
      });

      let irisAccount: Record<string, unknown> = {
        authenticated: false,
        email,
        account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`
      };
      try {
        if (irisAccountAuth && irisAccountAuth.user.email === email) {
          irisAccount = {
            authenticated: true,
            email,
            account_url: "/apps/iris/v3/account"
          };
        } else {
          const loginCode = await startIrisAccountLoginCode(email, { reuseActiveCode: true });
          irisAccount = {
            authenticated: false,
            email,
            account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`,
            code_status: loginCode.status,
            ...(loginCode.status === "send_failed"
              ? { code_error: loginCode.reason }
              : { verify_url: loginCode.verifyUrl })
          };
        }
      } catch (error) {
        req.log.warn({ err: error, email }, "IRIS Account login code could not be started after activation");
        irisAccount = {
          authenticated: false,
          email,
          account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`,
          code_status: "send_failed"
        };
      }

      sendJson(reply, 200, {
        status: "ok",
        iris_id: artwork.iris_id,
        display_iris_id: formatDisplayIrisId(artwork.iris_id, artwork.collection),
        image_url: artwork.image_url,
        activated_at: activatedAt,
        rarity_code: artwork.rarity_code,
        weight_grams: artwork.weight_grams,
        passport_url: `/pages/iris-passport?iris_id=${encodeURIComponent(artwork.iris_id)}`,
        collection: artwork.collection,
        iris_account: irisAccount
      });
    } catch (error) {
      req.log.error({ err: error }, "Activation verify failed");
      sendJson(reply, 500, { error: "activation_failed" });
    }
  };

  const redirectToActivatePage = (req: any, reply: any) => {
    const query = req.query as { iris?: string; iris_id?: string };
    const irisRaw = query?.iris_id ?? query?.iris ?? "";
    const irisId = irisRaw ? sanitizeIrisId(String(irisRaw)) : "";
    const target = irisId ? `/pages/activate?iris=${encodeURIComponent(irisId)}` : "/pages/activate";
    reply.redirect(302, target);
  };

  app.get("/activate-verify", redirectToActivatePage);
  app.get("/apps/iris/activate-verify", redirectToActivatePage);
  app.post("/activate-verify", handleActivateVerify);
  app.post("/apps/iris/activate-verify", handleActivateVerify);

  app.get("/apps/iris/activation-info", async (req, reply) => {
    const query = req.query as { token?: string };
    const token = query?.token?.trim();
    if (!token) {
      reply.code(400).send({ error: "missing_token" });
      return;
    }
    const artwork = await prisma.artwork.findUnique({
      where: { activation_token: token },
      select: {
        iris_id: true,
        image_url: true,
        status: true,
        activated_at: true,
        rarity_code: true,
        weight_grams: true,
        collection: {
          select: {
            slug: true,
            name: true,
            edition_size: true
          }
        }
      }
    });
    if (!artwork) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const pendingTransfer =
      artwork.status === "activated"
        ? await prisma.ownershipTransfer.findFirst({
            where: {
              iris_id: artwork.iris_id,
              status: "pending",
              expires_at: { gt: new Date() }
            },
            select: {
              to_email: true,
              expires_at: true
            },
            orderBy: { created_at: "desc" }
          })
        : null;
    reply.send({
      iris_id: artwork.iris_id,
      display_iris_id: formatDisplayIrisId(artwork.iris_id, artwork.collection),
      image_url: artwork.image_url,
      status: artwork.status,
      activated_at: artwork.activated_at,
      rarity_code: artwork.rarity_code,
      weight_grams: artwork.weight_grams,
      transfer_pending: Boolean(pendingTransfer),
      transfer_pending_to: pendingTransfer?.to_email ?? null,
      transfer_expires_at: pendingTransfer?.expires_at ?? null,
      collection: artwork.collection
    });
  });

  app.get("/apps/iris/seen-archive", async (req, reply) => {
    const query = req.query as { limit?: string; cursor?: string; rarity?: string; collection?: string; session?: string };
    const limit = parseLimit(query.limit, 20);
    let irisAccountAuth: Awaited<ReturnType<typeof getIrisAccountAuth>> | null = null;
    try {
      irisAccountAuth = await getIrisAccountAuth(req);
    } catch (error) {
      req.log.warn({ err: error }, "IRIS archive like auth check skipped");
    }

    const rarityParam = query.rarity?.trim();
    const rarityKey = rarityParam ? rarityParam.toLowerCase().replace(/\s+/g, " ") : "";
    const rarityMap: Record<string, string> = {
      common: "Common",
      uncommon: "Uncommon",
      rare: "Rare",
      "ultra rare": "Ultra Rare",
      "artist edition": "Artist Edition"
    };
    const rarityCode = rarityKey && rarityKey !== "all" ? rarityMap[rarityKey] : null;
    if (rarityKey && rarityKey !== "all" && !rarityCode) {
      reply.code(400).send({ error: "invalid_rarity" });
      return;
    }

    const collectionSlug = query.collection?.trim() ? normalizeCollectionSlug(query.collection) : null;
    const coreCollectionRequested = isCoreCollectionAlias(collectionSlug);
    let collectionMeta: { id: string; slug: string; name: string; edition_size: number; artworks_count: number; status: string } | null = null;
    if (collectionSlug && !coreCollectionRequested) {
      const collection = await prisma.collection.findUnique({
        where: { slug: collectionSlug },
        select: { id: true, slug: true, name: true, edition_size: true, artworks_count: true, status: true }
      });
      if (!collection) {
        reply.code(404).send({ error: "collection_not_found" });
        return;
      }
      collectionMeta = collection;
    } else if (coreCollectionRequested) {
      collectionMeta = {
        id: "core",
        slug: CORE_COLLECTION_SLUG,
        name: "IRIS Collection",
        edition_size: 10_000,
        artworks_count: 10_000,
        status: "active"
      };
    }

    let cursorFilter = {};
    if (query.cursor) {
      try {
        const cursor = decodeCursor(query.cursor);
        const sortAt = new Date(cursor.sortAt);
        cursorFilter = {
          OR: [
            { activated_at: { lt: sortAt } },
            { activated_at: sortAt, iris_id: { lt: cursor.irisId } }
          ]
        };
      } catch {
        reply.code(400).send({ error: "invalid_cursor" });
        return;
      }
    }

    const where: Prisma.ArtworkWhereInput = { status: "activated", activated_at: { not: null } };
    if (rarityCode) {
      where.rarity_code = rarityCode;
    }
    if (collectionMeta && coreCollectionRequested) {
      where.collection_id = null;
    } else if (collectionMeta) {
      where.collection_id = collectionMeta.id;
    }
    Object.assign(where, cursorFilter);

    const [items, totalCount] = await Promise.all([
      prisma.artwork.findMany({
        where,
        orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }],
        take: limit + 1,
        include: {
          collection: {
            select: {
              slug: true,
              name: true,
              edition_size: true
            }
          }
        }
      }),
      prisma.artwork.count({
        where: {
          status: "activated",
          activated_at: { not: null },
          ...(coreCollectionRequested ? { collection_id: null } : collectionMeta ? { collection_id: collectionMeta.id } : {}),
          ...(rarityCode ? { rarity_code: rarityCode } : {})
        }
      })
    ]);

    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;
    const likeState = await loadArchiveLikeState(
      slice.map((item) => item.iris_id),
      irisAccountAuth?.user.id ?? null
    );
    const nextCursor = hasMore
      ? encodeCursor({
          sortAt: (slice[slice.length - 1].activated_at ?? slice[slice.length - 1].updated_at).toISOString(),
          irisId: slice[slice.length - 1].iris_id
        })
      : null;

    sendJson(reply, 200, {
      items: slice.map((item) => ({
        iris_id: item.iris_id,
        display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
        status: item.status,
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        activated_at: item.activated_at,
        weight_grams: item.weight_grams,
        collection: item.collection,
        ...(likeState.enabled
          ? {
              like_count: likeState.counts.get(item.iris_id) ?? 0,
              liked_by_me: likeState.liked.has(item.iris_id)
            }
          : {})
      })),
      nextCursor,
      total_count: totalCount,
      likes_enabled: likeState.enabled,
      collection: collectionMeta
    });
  });

  app.post("/apps/iris/archive-like", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const sessionToken = readSingleValue(body.session).trim();
    const auth = await getIrisAccountAuth(req, sessionToken);
    if (!auth) {
      sendJson(reply, 401, { error: "not_authenticated", account_url: "/apps/iris/v3/account" });
      return;
    }

    const irisId = normalizeIrisIdInput(readSingleValue(body.iris_id));
    if (!irisId) {
      sendJson(reply, 400, { error: "missing_iris_id" });
      return;
    }

    const artwork = await prisma.artwork.findUnique({
      where: { iris_id: irisId },
      select: { iris_id: true, status: true, activated_at: true }
    });
    if (!artwork || artwork.status !== "activated" || !artwork.activated_at) {
      sendJson(reply, 404, { error: "not_found" });
      return;
    }

    try {
      const existing = await prisma.artworkLike.findUnique({
        where: {
          iris_id_user_id: {
            iris_id: irisId,
            user_id: auth.user.id
          }
        },
        select: { id: true }
      });

      if (existing) {
        await prisma.artworkLike.delete({ where: { id: existing.id } });
        sendJson(reply, 200, {
          status: "ok",
          iris_id: irisId,
          liked: false,
          like_count: await countArtworkLikes(irisId)
        });
        return;
      }

      await prisma.artworkLike.create({
        data: {
          iris_id: irisId,
          user_id: auth.user.id
        }
      });
      sendJson(reply, 200, {
        status: "ok",
        iris_id: irisId,
        liked: true,
        like_count: await countArtworkLikes(irisId)
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        sendJson(reply, 200, {
          status: "ok",
          iris_id: irisId,
          liked: true,
          like_count: await countArtworkLikes(irisId)
        });
        return;
      }
      req.log.error({ err: error, irisId, userId: auth.user.id }, "IRIS archive like toggle failed");
      sendJson(reply, 503, { error: "likes_not_ready" });
    }
  });

  app.get("/apps/iris/my-iris", async (req, reply) => {
    const query = req.query as { email?: string };
    const customerEmail = normalizeEmail(query.email);
    if (!customerEmail) {
      sendJson(reply, 400, { error: "missing_email" });
      return;
    }

    const items = await prisma.artwork.findMany({
      where: {
        status: "activated",
        OR: [
          { owner_email: customerEmail },
          { owner_email: null, assigned_customer_email: customerEmail }
        ]
      },
      orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }],
      include: {
        collection: {
          select: {
            slug: true,
            name: true,
            edition_size: true
          }
        }
      }
    });

    const pendingTransfersByIrisId = new Map<string, { to_email: string; expires_at: Date }>();
    if (items.length > 0) {
      try {
        const pendingTransfers = await prisma.ownershipTransfer.findMany({
          where: {
            iris_id: { in: items.map((item) => item.iris_id) },
            status: "pending",
            expires_at: { gt: new Date() }
          },
          orderBy: { created_at: "desc" },
          select: {
            iris_id: true,
            to_email: true,
            expires_at: true
          }
        });
        for (const transfer of pendingTransfers) {
          if (!pendingTransfersByIrisId.has(transfer.iris_id)) {
            pendingTransfersByIrisId.set(transfer.iris_id, transfer);
          }
        }
      } catch (error) {
        req.log.warn({ err: error }, "Pending transfer lookup skipped");
      }
    }

    const generatedTokens = new Map<string, string>();
    const missing = items.filter((item) => !item.proof_token);
    if (missing.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const item of missing) {
          const token = crypto.randomUUID();
          await tx.artwork.update({
            where: { iris_id: item.iris_id },
            data: { proof_token: token }
          });
          generatedTokens.set(item.iris_id, token);
        }
      });
    }

    sendJson(reply, 200, {
      items: items.map((item) => {
        const pendingTransfer = pendingTransfersByIrisId.get(item.iris_id);
        return {
          iris_id: item.iris_id,
          display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
          image_url: item.image_url,
          rarity_code: item.rarity_code,
          activated_at: item.activated_at,
          collection: item.collection,
          transfer_pending: Boolean(pendingTransfer),
          transfer_pending_to: pendingTransfer?.to_email ?? null,
          transfer_expires_at: pendingTransfer?.expires_at ?? null,
          passport_url: (item.proof_token ?? generatedTokens.get(item.iris_id))
            ? `/pages/iris-passport?iris_id=${encodeURIComponent(item.iris_id)}&token=${encodeURIComponent(
                item.proof_token ?? generatedTokens.get(item.iris_id) ?? ""
              )}`
            : `/pages/iris-passport?iris_id=${encodeURIComponent(item.iris_id)}`
        };
      })
    });
  });

  const sendIrisAccountHtml = (reply: any, html: string) =>
    reply
      .code(200)
      .header("X-Robots-Tag", "noindex, nofollow")
      .type("text/html; charset=utf-8")
      .send(html);

  const renderIrisAccountLibrary = async (
    reply: any,
    user: IrisAccountUserView,
    options?: { message?: string; error?: string; sessionToken?: string }
  ) => {
    const [items, goldPrice] = await Promise.all([
      loadIrisAccountItems(user.email),
      loadLiveGoldPriceUsdG().catch((error) => {
        app.log.warn({ err: error }, "Could not load gold price for IRIS account stats");
        return null;
      })
    ]);
    sendIrisAccountHtml(
      reply,
      buildIrisAccountLibraryHtml({
        user,
        sessionToken: options?.sessionToken,
        message: options?.message,
        error: options?.error,
        items,
        goldPriceUsdG: goldPrice?.price ?? null
      })
    );
  };

  const renderIrisAccountSettings = async (
    reply: any,
    user: IrisAccountUserView,
    options?: { message?: string; error?: string; sessionToken?: string }
  ) => {
    const items = await loadIrisAccountItems(user.email);
    const avatarUrl = selectIrisAccountAvatarUrl(items, user.avatar_iris_id);
    sendIrisAccountHtml(
      reply,
      buildIrisAccountSettingsHtml({
        user,
        sessionToken: options?.sessionToken,
        message: options?.message,
        error: options?.error,
        libraryCount: items.length,
        avatarUrl
      })
    );
  };

  const renderIrisAccountOrders = async (
    reply: any,
    user: IrisAccountUserView,
    options?: { sessionToken?: string }
  ) => {
    const [items, orders] = await Promise.all([
      loadIrisAccountItems(user.email),
      loadIrisAccountOrders(user.email)
    ]);
    sendIrisAccountHtml(
      reply,
      buildIrisAccountOrdersHtml({
        user,
        sessionToken: options?.sessionToken,
        avatarUrl: selectIrisAccountAvatarUrl(items, user.avatar_iris_id),
        orders
      })
    );
  };

  const renderIrisAccountMarketplace = async (
    reply: any,
    user: IrisAccountUserView,
    options?: { sessionToken?: string }
  ) => {
    const [userItems, marketplaceItems] = await Promise.all([
      loadIrisAccountItems(user.email),
      loadIrisAccountItems(IRIS_MARKETPLACE_PREVIEW_EMAIL)
    ]);
    sendIrisAccountHtml(
      reply,
      buildIrisAccountMarketplaceHtml({
        user,
        sessionToken: options?.sessionToken,
        avatarUrl: selectIrisAccountAvatarUrl(userItems, user.avatar_iris_id),
        items: marketplaceItems
      })
    );
  };

  app.get("/apps/iris/v3", async (_req, reply) => {
    reply.redirect(302, "/apps/iris/v3/account");
  });

  app.get("/apps/iris/v3/account", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        const query = (req.query as { email?: unknown } | null) ?? {};
        const email = normalizeEmail(query.email);
        sendIrisAccountHtml(reply, buildIrisAccountLoginHtml({ email }));
        return;
      }

      await prisma.irisAccountSession.update({
        where: { id: auth.session.id },
        data: { last_seen_at: new Date() }
      });
      await renderIrisAccountLibrary(reply, auth.user, { sessionToken: auth.rawToken });
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account V3 page failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.get("/apps/iris/v3/session", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        reply.code(200).type("application/json; charset=utf-8").send({
          authenticated: false,
          account_url: "/apps/iris/v3/account"
        });
        return;
      }

      await prisma.irisAccountSession.update({
        where: { id: auth.session.id },
        data: { last_seen_at: new Date() }
      });
      reply.code(200).type("application/json; charset=utf-8").send({
        authenticated: true,
        email: auth.user.email,
        username: auth.user.username,
        display_name: auth.user.display_name,
        account_url: "/apps/iris/v3/account"
      });
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account session check failed");
      reply.code(200).type("application/json; charset=utf-8").send({
        authenticated: false,
        account_url: "/apps/iris/v3/account"
      });
    }
  });

  app.get("/apps/iris/v3/profile", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        reply.redirect(302, "/apps/iris/v3/account");
        return;
      }
      await renderIrisAccountSettings(reply, auth.user, { sessionToken: auth.rawToken });
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account V3 profile page failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.get("/apps/iris/v3/orders", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        reply.redirect(302, "/apps/iris/v3/account");
        return;
      }
      await renderIrisAccountOrders(reply, auth.user, { sessionToken: auth.rawToken });
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account V3 orders page failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.get("/apps/iris/v3/marketplace", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        reply.redirect(302, "/apps/iris/v3/account");
        return;
      }
      await renderIrisAccountMarketplace(reply, auth.user, { sessionToken: auth.rawToken });
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account V3 marketplace page failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.get("/apps/iris/v3/passport", async (req, reply) => {
    try {
      const auth = await getIrisAccountAuth(req);
      if (!auth) {
        reply.redirect(302, "/apps/iris/v3/account");
        return;
      }
      const query = (req.query as { iris_id?: unknown } | null) ?? {};
      const irisId = normalizeIrisIdInput(readSingleValue(query.iris_id));
      if (!irisId) {
        await renderIrisAccountLibrary(reply, auth.user, {
          sessionToken: auth.rawToken,
          error: "IRIS passport could not be opened."
        });
        return;
      }
      const item = await loadIrisAccountPassportItem(auth.user.email, irisId);
      if (!item) {
        await renderIrisAccountLibrary(reply, auth.user, {
          sessionToken: auth.rawToken,
          error: "This IRIS is not registered to this account."
        });
        return;
      }
      const transferPendingTo = await loadPendingTransferTo(item.iris_id);
      const items = await loadIrisAccountItems(auth.user.email);
      sendIrisAccountHtml(
        reply,
        buildIrisAccountPassportHtml({
          user: auth.user,
          item,
          sessionToken: auth.rawToken,
          avatarUrl: selectIrisAccountAvatarUrl(items, auth.user.avatar_iris_id),
          transferPendingTo
        })
      );
    } catch (error) {
      req.log.error({ err: error }, "IRIS Account V3 passport page failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.post("/apps/iris/v3/avatar", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const sessionToken = readSingleValue(body.session).trim();
    const auth = await getIrisAccountAuth(req, sessionToken);
    if (!auth) {
      reply.redirect(302, "/apps/iris/v3/account");
      return;
    }

    const irisId = normalizeIrisIdInput(readSingleValue(body.iris_id));
    if (!irisId) {
      await renderIrisAccountLibrary(reply, auth.user, {
        sessionToken: auth.rawToken,
        error: "Avatar could not be changed."
      });
      return;
    }

    const item = await loadIrisAccountPassportItem(auth.user.email, irisId);
    if (!item) {
      await renderIrisAccountLibrary(reply, auth.user, {
        sessionToken: auth.rawToken,
        error: "This IRIS is not registered to this account."
      });
      return;
    }
    if (!item.image_url) {
      await renderIrisAccountLibrary(reply, auth.user, {
        sessionToken: auth.rawToken,
        error: "This IRIS does not have an image yet."
      });
      return;
    }

    try {
      await prisma.event.create({
        data: {
          iris_id: item.iris_id,
          type: "iris_account_avatar_set",
          actor: auth.user.email,
          payload_json: {
            user_id: auth.user.id,
            avatar_iris_id: item.iris_id
          }
        }
      });
      await renderIrisAccountLibrary(reply, { ...auth.user, avatar_iris_id: item.iris_id }, {
        sessionToken: auth.rawToken,
        message: `${formatIrisAccountArchiveLabel(item.display_iris_id || item.iris_id)} is now your avatar.`
      });
    } catch (error) {
      req.log.error({ err: error, irisId, userId: auth.user.id }, "IRIS Account avatar update failed");
      await renderIrisAccountLibrary(reply, auth.user, {
        sessionToken: auth.rawToken,
        error: "Avatar could not be changed."
      });
    }
  });

  app.post("/apps/iris/v3/login/request", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const email = normalizeEmail(body.email);
    if (!email || !isValidEmail(email)) {
      sendIrisAccountHtml(reply, buildIrisAccountLoginHtml({ error: "Please enter a valid email.", email }));
      return;
    }

    try {
      const loginCode = await startIrisAccountLoginCode(email);
      if (loginCode.status === "send_failed") {
        sendIrisAccountHtml(
          reply,
          buildIrisAccountLoginHtml({
            error: `We could not send the login code (${loginCode.reason}).`,
            email
          })
        );
        return;
      }

      sendIrisAccountHtml(reply, buildIrisAccountVerifyHtml({ email }));
    } catch (error) {
      req.log.error({ err: error, email }, "IRIS Account login request failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountLoginHtml({ error: "IRIS Account V3 is not ready yet. Please check the backend migration.", email })
      );
    }
  });

  app.get("/apps/iris/v3/login/verify", async (req, reply) => {
    const query = (req.query as { email?: unknown } | null) ?? {};
    const email = normalizeEmail(query.email);
    if (!email || !isValidEmail(email)) {
      reply.redirect(302, "/apps/iris/v3/account");
      return;
    }
    const auth = await getIrisAccountAuth(req);
    if (auth && auth.user.email === email) {
      reply.redirect(302, "/apps/iris/v3/account");
      return;
    }
    sendIrisAccountHtml(reply, buildIrisAccountVerifyHtml({ email }));
  });

  app.post("/apps/iris/v3/login/verify", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const email = normalizeEmail(body.email);
    const code = readSingleValue(body.code).trim().replace(/\s+/g, "");
    if (!email || !isValidEmail(email) || !code) {
      sendIrisAccountHtml(reply, buildIrisAccountVerifyHtml({ email, error: "Please enter the code from your email." }));
      return;
    }

    try {
      const loginCode = await prisma.irisAccountLoginCode.findFirst({
        where: {
          email,
          consumed_at: null,
          expires_at: { gt: new Date() }
        },
        orderBy: { created_at: "desc" }
      });

      if (!loginCode || loginCode.attempts >= IRIS_LOGIN_CODE_MAX_ATTEMPTS) {
        sendIrisAccountHtml(reply, buildIrisAccountVerifyHtml({ email, error: "This code is expired. Request a new code." }));
        return;
      }

      if (loginCode.code_hash !== hashLoginCode(email, code)) {
        await prisma.irisAccountLoginCode.update({
          where: { id: loginCode.id },
          data: { attempts: { increment: 1 } }
        });
        sendIrisAccountHtml(reply, buildIrisAccountVerifyHtml({ email, error: "Invalid code. Please try again." }));
        return;
      }

      const user = await findOrCreateIrisUserByEmail(email);
      const session = await createIrisAccountSession(user.id);
      await prisma.$transaction([
        prisma.irisAccountLoginCode.update({
          where: { id: loginCode.id },
          data: { consumed_at: new Date() }
        }),
        prisma.irisUser.update({
          where: { id: user.id },
          data: { last_login_at: new Date() },
          select: { id: true }
        })
      ]);

      setIrisAccountSessionCookie(reply, session.rawToken, session.expiresAt);
      reply.redirect(302, `/apps/iris/v3/account?session=${encodeURIComponent(session.rawToken)}`);
    } catch (error) {
      req.log.error({ err: error, email }, "IRIS Account login verify failed");
      sendIrisAccountHtml(
        reply,
        buildIrisAccountVerifyHtml({ email, error: "IRIS Account V3 is not ready yet. Please check the backend migration." })
      );
    }
  });

  app.post("/apps/iris/v3/profile", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const sessionToken = readSingleValue(body.session).trim();
    const auth = await getIrisAccountAuth(req, sessionToken);
    if (!auth) {
      reply.redirect(302, "/apps/iris/v3/account");
      return;
    }

    const username = normalizeUsername(body.username);
    const displayName = readSingleValue(body.display_name).trim().slice(0, 80) || null;
    const profilePublicValue = readSingleValue(body.profile_public).trim().toLowerCase();
    const profilePublic =
      profilePublicValue === "true" || profilePublicValue === "public" || profilePublicValue === "on";

    if (!isValidUsername(username)) {
      await renderIrisAccountSettings(reply, auth.user, {
        sessionToken: auth.rawToken,
        error: "Username must be 3-24 characters, lowercase letters/numbers/hyphens, and cannot start or end with a hyphen."
      });
      return;
    }

    try {
      const updated = await prisma.irisUser.update({
        where: { id: auth.user.id },
        data: {
          username,
          display_name: displayName,
          profile_public: profilePublic
        },
        select: IRIS_ACCOUNT_USER_SELECT
      });
      await renderIrisAccountSettings(reply, await withIrisAccountAvatar(updated), {
        message: "Profile saved.",
        sessionToken: auth.rawToken
      });
    } catch (error) {
      const message =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? "This username is already taken."
          : "Profile could not be saved.";
      await renderIrisAccountSettings(reply, auth.user, { error: message, sessionToken: auth.rawToken });
    }
  });

  app.post("/apps/iris/v3/logout", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const sessionToken = readSingleValue(body.session).trim();
    const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
    const rawToken = sessionToken || cookies[IRIS_ACCOUNT_SESSION_COOKIE];
    if (rawToken) {
      await prisma.irisAccountSession.deleteMany({
        where: {
          token_hash: hashOpaqueToken(rawToken)
        }
      });
    }
    clearIrisAccountSessionCookie(reply);
    reply.redirect(302, "/apps/iris/v3/account");
  });

  app.post("/apps/iris/transfer-request", async (req, reply) => {
    let irisId = "";
    try {
      const body = (req.body ?? {}) as {
        iris_id?: string;
        from_email?: string;
        to_email?: string;
      };
      irisId = normalizeIrisIdInput(readSingleValue(body.iris_id));
      const fromEmail = normalizeEmail(body.from_email);
      const toEmail = normalizeEmail(body.to_email);

      if (!irisId || !fromEmail || !toEmail) {
        sendJson(reply, 400, { error: "missing_required_fields" });
        return;
      }
      if (!isValidEmail(fromEmail) || !isValidEmail(toEmail)) {
        sendJson(reply, 400, { error: "invalid_email" });
        return;
      }
      if (fromEmail === toEmail) {
        sendJson(reply, 400, { error: "same_email" });
        return;
      }

      const artwork = await prisma.artwork.findUnique({
        where: { iris_id: irisId },
        include: {
          collection: {
            select: {
              slug: true,
              name: true,
              edition_size: true
            }
          }
        }
      });

      if (!artwork) {
        sendJson(reply, 404, { error: "iris_not_found" });
        return;
      }
      if (artwork.status !== "activated") {
        sendJson(reply, 409, { error: "not_activated" });
        return;
      }
      const currentOwner = normalizeEmail(artwork.owner_email);
      const assignedCustomer = normalizeEmail(artwork.assigned_customer_email);
      const canTransfer =
        currentOwner === fromEmail || (!currentOwner && assignedCustomer === fromEmail);
      if (!canTransfer) {
        sendJson(reply, 403, { error: "owner_mismatch" });
        return;
      }

      const transferCode = generateTransferCode();
      const expiresAt = new Date(Date.now() + TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000);
      let transferId = "";
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        const canceled = await tx.ownershipTransfer.updateMany({
          where: {
            iris_id: artwork.iris_id,
            status: "pending"
          },
          data: {
            status: "canceled",
            canceled_at: now
          }
        });

        const transfer = await tx.ownershipTransfer.create({
          data: {
            iris_id: artwork.iris_id,
            from_email: fromEmail,
            to_email: toEmail,
            code_hash: hashTransferCode(transferCode),
            code_last4: transferCode.slice(-4),
            expires_at: expiresAt
          }
        });
        transferId = transfer.id;

        await tx.event.create({
          data: {
            iris_id: artwork.iris_id,
            type: "transfer_requested",
            actor: fromEmail,
            payload_json: {
              transfer_id: transfer.id,
              from_email: fromEmail,
              to_email: toEmail,
              expires_at: expiresAt.toISOString(),
              canceled_previous_count: canceled.count
            }
          }
        });
      });

      const emailResult = await sendOwnershipTransferEmailBestEffort({
        toEmail,
        fromEmail,
        displayIrisId: formatDisplayIrisId(artwork.iris_id, artwork.collection),
        transferCode,
        expiresAt,
        imageUrl: artwork.image_url,
        weightGrams: artwork.weight_grams,
        rarityCode: artwork.rarity_code,
        activatedAt: artwork.activated_at
      });

      if (!emailResult.sent) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.ownershipTransfer.update({
              where: { id: transferId },
              data: {
                status: "canceled",
                canceled_at: new Date()
              }
            });
            await tx.event.create({
              data: {
                iris_id: artwork.iris_id,
                type: "transfer_email_failed",
                actor: "system",
                payload_json: {
                  transfer_id: transferId,
                  to_email: toEmail,
                  reason: emailResult.reason
                }
              }
            });
          });
        } catch (cleanupError) {
          req.log.error(
            { err: cleanupError, irisId: artwork.iris_id, transferId, reason: emailResult.reason },
            "Transfer email failure cleanup failed"
          );
        }
        sendJson(reply, 502, {
          error: "transfer_email_failed",
          reason: emailResult.reason
        });
        return;
      }

      sendJson(reply, 200, {
        status: "ok",
        iris_id: artwork.iris_id,
        display_iris_id: formatDisplayIrisId(artwork.iris_id, artwork.collection),
        to_email: toEmail,
        expires_at: expiresAt
      });
    } catch (error) {
      req.log.error({ err: error, irisId }, "Transfer request failed");
      sendJson(reply, 500, {
        error: "transfer_request_failed",
        reason: publicTransferErrorReason(error)
      });
    }
  });

  app.post("/apps/iris/transfer-claim", async (req, reply) => {
    const body = req.body as {
      iris_id?: string;
      token?: string;
      email?: string;
      transfer_code?: string;
      iris_account_session?: string;
      session?: string;
    };
    const rawIrisId = readSingleValue(body.iris_id);
    const token = readSingleValue(body.token).trim();
    let irisId = rawIrisId ? normalizeIrisIdInput(rawIrisId) : "";
    const email = normalizeEmail(body.email);
    const transferCode = normalizeTransferCode(readSingleValue(body.transfer_code));
    const submittedSessionToken = readSingleValue(body.iris_account_session || body.session).trim();

    if ((!irisId && !token) || !email || !transferCode) {
      sendJson(reply, 400, { error: "missing_required_fields" });
      return;
    }
    if (!isValidEmail(email)) {
      sendJson(reply, 400, { error: "invalid_email" });
      return;
    }

    try {
      let irisAccountAuth: Awaited<ReturnType<typeof getIrisAccountAuth>> | null = null;
      try {
        irisAccountAuth = await getIrisAccountAuth(req, submittedSessionToken);
      } catch (error) {
        req.log.warn({ err: error }, "IRIS Account auth check skipped during transfer claim");
      }

      let artwork = irisId
        ? await prisma.artwork.findUnique({
            where: { iris_id: irisId },
            include: {
              collection: {
                select: {
                  slug: true,
                  name: true,
                  edition_size: true
                }
              }
            }
          })
        : null;
      if (!artwork && token) {
        artwork = await prisma.artwork.findUnique({
          where: { activation_token: token },
          include: {
            collection: {
              select: {
                slug: true,
                name: true,
                edition_size: true
              }
            }
          }
        });
      }

      if (!artwork) {
        sendJson(reply, 404, { error: "iris_not_found" });
        return;
      }
      irisId = artwork.iris_id;
      if (artwork.status !== "activated") {
        sendJson(reply, 409, { error: "not_activated" });
        return;
      }
      if (artwork.activation_token && (!token || token !== artwork.activation_token)) {
        sendJson(reply, 403, { error: "invalid_activation_link" });
        return;
      }

      const transfer = await prisma.ownershipTransfer.findFirst({
        where: {
          iris_id: artwork.iris_id,
          status: "pending",
          to_email: email
        },
        orderBy: { created_at: "desc" }
      });

      if (!transfer) {
        sendJson(reply, 404, { error: "transfer_not_found" });
        return;
      }

      const now = new Date();
      if (transfer.expires_at <= now) {
        await prisma.$transaction(async (tx) => {
          await tx.ownershipTransfer.update({
            where: { id: transfer.id },
            data: { status: "expired" }
          });
          await tx.event.create({
            data: {
              iris_id: artwork.iris_id,
              type: "transfer_expired",
              actor: email,
              payload_json: {
                transfer_id: transfer.id,
                to_email: email
              }
            }
          });
        });
        sendJson(reply, 410, { error: "transfer_expired" });
        return;
      }

      if (transfer.locked_until && transfer.locked_until > now) {
        sendJson(reply, 429, { error: "too_many_attempts", retry_at: transfer.locked_until });
        return;
      }

      if (transfer.code_hash !== hashTransferCode(transferCode)) {
        const nextAttempts = transfer.attempts + 1;
        const lockedUntil =
          nextAttempts >= TRANSFER_MAX_ATTEMPTS
            ? new Date(Date.now() + TRANSFER_LOCK_MINUTES * 60 * 1000)
            : null;

        await prisma.$transaction(async (tx) => {
          await tx.ownershipTransfer.update({
            where: { id: transfer.id },
            data: {
              attempts: nextAttempts,
              locked_until: lockedUntil
            }
          });
          await tx.event.create({
            data: {
              iris_id: artwork.iris_id,
              type: lockedUntil ? "transfer_claim_blocked" : "transfer_claim_failed",
              actor: email,
              payload_json: {
                transfer_id: transfer.id,
                reason: lockedUntil ? "max_attempts" : "invalid_transfer_code",
                attempts: nextAttempts,
                locked_until: lockedUntil ? lockedUntil.toISOString() : null
              }
            }
          });
        });

        if (lockedUntil) {
          sendJson(reply, 429, { error: "too_many_attempts", retry_at: lockedUntil });
        } else {
          sendJson(reply, 401, { error: "invalid_transfer_code" });
        }
        return;
      }

      const previousOwnerEmail = artwork.owner_email;
      const proofToken = crypto.randomUUID();
      const claimedAt = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.ownershipTransfer.update({
          where: { id: transfer.id },
          data: {
            status: "claimed",
            claimed_at: claimedAt,
            attempts: 0,
            locked_until: null
          }
        });
        await tx.artwork.update({
          where: { iris_id: artwork.iris_id },
          data: {
            owner_email: email,
            proof_token: proofToken
          }
        });
        await tx.event.create({
          data: {
            iris_id: artwork.iris_id,
            type: "ownership_transferred",
            actor: email,
            payload_json: {
              transfer_id: transfer.id,
              previous_owner_email: previousOwnerEmail,
              new_owner_email: email,
              from_email: transfer.from_email,
              claimed_at: claimedAt.toISOString()
            }
          }
        });
      });

      let irisAccount: Record<string, unknown> = {
        authenticated: false,
        email,
        account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`
      };
      try {
        if (irisAccountAuth && irisAccountAuth.user.email === email) {
          irisAccount = {
            authenticated: true,
            email,
            account_url: "/apps/iris/v3/account"
          };
        } else {
          const loginCode = await startIrisAccountLoginCode(email, { reuseActiveCode: true });
          irisAccount = {
            authenticated: false,
            email,
            account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`,
            code_status: loginCode.status,
            ...(loginCode.status === "send_failed"
              ? { code_error: loginCode.reason }
              : { verify_url: loginCode.verifyUrl })
          };
        }
      } catch (error) {
        req.log.warn({ err: error, email }, "IRIS Account login code could not be started after transfer claim");
        irisAccount = {
          authenticated: false,
          email,
          account_url: `/apps/iris/v3/account?email=${encodeURIComponent(email)}`,
          code_status: "send_failed"
        };
      }

      sendJson(reply, 200, {
        status: "ok",
        iris_id: artwork.iris_id,
        display_iris_id: formatDisplayIrisId(artwork.iris_id, artwork.collection),
        image_url: artwork.image_url,
        activated_at: artwork.activated_at,
        rarity_code: artwork.rarity_code,
        weight_grams: artwork.weight_grams,
        passport_url: `/pages/iris-passport?iris_id=${encodeURIComponent(artwork.iris_id)}&token=${encodeURIComponent(
          proofToken
        )}`,
        collection: artwork.collection,
        iris_account: irisAccount
      });
    } catch (error) {
      req.log.error({ err: error, irisId }, "Transfer claim failed");
      sendJson(reply, 500, { error: "transfer_claim_failed" });
    }
  });

  app.get("/apps/iris/iris/:irisId", async (req, reply) => {
    const params = req.params as { irisId: string };
    const query = req.query as { token?: string; session?: string };
    const irisId = sanitizeIrisId(params.irisId);
    if (!irisId) {
      sendJson(reply, 400, { error: "invalid_iris_id" });
      return;
    }
    let irisAccountAuth: Awaited<ReturnType<typeof getIrisAccountAuth>> | null = null;
    try {
      irisAccountAuth = await getIrisAccountAuth(req);
    } catch (error) {
      req.log.warn({ err: error, irisId }, "IRIS passport like auth check skipped");
    }

    const item = await prisma.artwork.findUnique({
      where: { iris_id: irisId },
      include: {
        collection: {
          select: {
            slug: true,
            name: true,
            edition_size: true
          }
        }
      }
    });

    if (!item || item.status !== "activated") {
      sendJson(reply, 404, { error: "not_found" });
      return;
    }

    const tokenOk = !!query.token && item.proof_token === query.token;
    const proofPath = tokenOk ? `/apps/iris/proof/${item.iris_id}?token=${encodeURIComponent(query.token!)}` : null;
    const pendingTransfer = await prisma.ownershipTransfer.findFirst({
      where: {
        iris_id: item.iris_id,
        status: "pending",
        expires_at: { gt: new Date() }
      },
      select: {
        to_email: true,
        expires_at: true
      },
      orderBy: { created_at: "desc" }
    });
    const likeState = await loadArchiveLikeState([item.iris_id], irisAccountAuth?.user.id ?? null);
    sendJson(reply, 200, {
      iris_id: item.iris_id,
      display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
      image_url: item.image_url,
      rarity_code: item.rarity_code,
      weight_grams: item.weight_grams,
      activated_at: item.activated_at,
      status: item.status,
      transfer_pending: Boolean(pendingTransfer),
      transfer_pending_to: pendingTransfer?.to_email ?? null,
      transfer_expires_at: pendingTransfer?.expires_at ?? null,
      proof_url: proofPath,
      collection: item.collection,
      ...(likeState.enabled
        ? {
            like_count: likeState.counts.get(item.iris_id) ?? 0,
            liked_by_me: likeState.liked.has(item.iris_id)
          }
        : {}),
      likes_enabled: likeState.enabled
    });
  });

  app.get("/apps/iris/verify", async (_req, reply) => {
    const latest = await prisma.event.findFirst({
      where: { type: "rarity_merkle_root" },
      orderBy: { created_at: "desc" }
    });
    const root = (latest?.payload_json as any)?.root ?? "pending";
    const html = publicProofHtmlTemplate.replace("{{ROOT}}", root);
    reply.code(200).type("text/html; charset=utf-8").send(html);
  });

  app.get("/apps/iris/gold-price", async (_req, reply) => {
    try {
      const goldPrice = await loadLiveGoldPriceUsdG();
      sendJson(reply, 200, { price_usd_g: goldPrice.price, updated_at: goldPrice.updatedAt.toISOString() });
    } catch (err) {
      app.log.error({ err }, "Gold API fetch failed");
      const message = err instanceof Error ? err.message : "";
      sendJson(reply, message === "gold_api_key_missing" ? 503 : 502, {
        error: message === "gold_api_key_missing" ? "gold_api_key_missing" : "gold_api_failed"
      });
    }
  });

  app.get("/apps/iris/proof/:irisId", async (req, reply) => {
    const params = req.params as { irisId: string };
    const query = req.query as { token?: string };
    const irisId = sanitizeIrisId(params.irisId);
    if (!irisId) {
      sendJson(reply, 400, { error: "invalid_iris_id" });
      return;
    }
    const item = await prisma.artwork.findUnique({ where: { iris_id: irisId } });
    if (
      !item ||
      item.status !== "activated" ||
      !item.rarity_code ||
      !item.rarity_proof ||
      !query.token ||
      item.proof_token !== query.token
    ) {
      sendJson(reply, 404, { error: "not_found" });
      return;
    }
    const proof = item.rarity_proof as { nonce: string; proof: string[]; root: string };
    const leaf = computeLeaf(item.iris_id, item.rarity_code as any, proof.nonce);
    const ok = verifyMerkleProof(leaf, proof.proof, proof.root);
    const payload = {
      iris_id: item.iris_id,
      rarity_code: item.rarity_code,
      root: proof.root,
      proof: proof.proof,
      nonce: proof.nonce,
      valid: ok
    };

    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/html")) {
      const html = `<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>IRIS Proof ${item.iris_id}</title>
            <style>
              body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7fb; color: #111; }
              .page { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
              .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 24px; }
              h1 { margin: 0 0 12px; }
              .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
              .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
              .grid { display: grid; gap: 12px; }
              .btn { display: inline-block; padding: 10px 14px; background: #5E81F4; color: #fff; border-radius: 10px; text-decoration: none; font-weight: 600; }
              pre { background: #f3f4f6; padding: 12px; border-radius: 10px; overflow: auto; }
            </style>
          </head>
          <body>
            <div class="page">
              <div class="card">
                <h1>IRIS Proof</h1>
                <div class="grid">
                  <div><div class="label">IRIS ID</div><div class="mono">${payload.iris_id}</div></div>
                  <div><div class="label">Rarity</div><div>${payload.rarity_code}</div></div>
                  <div><div class="label">Merkle Root</div><div class="mono">${payload.root}</div></div>
                  <div><div class="label">Nonce</div><div class="mono">${payload.nonce}</div></div>
                  <div><div class="label">Valid</div><div>${payload.valid ? "true" : "false"}</div></div>
                </div>
                <p style="margin-top:16px;">Proof array (sibling hashes):</p>
                <pre class="mono">${JSON.stringify(payload.proof, null, 2)}</pre>
                <p style="margin-top:16px;">Raw JSON:</p>
                <pre class="mono">${JSON.stringify(payload, null, 2)}</pre>
                <div style="margin-top:16px;">
                  <a class="btn" href="/apps/iris/verify">Rarity Root Page</a>
                </div>
              </div>
            </div>
          </body>
        </html>`;
      reply.code(200).type("text/html; charset=utf-8").send(html);
      return;
    }

    sendJson(reply, 200, payload);
  });

  app.get("/admin/collaborators", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const collaborators = await prisma.collaboratorUser.findMany({
      include: {
        collection: {
          select: {
            name: true,
            edition_size: true
          }
        }
      },
      orderBy: [{ created_at: "desc" }, { full_name: "asc" }]
    });

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildCollaboratorsAdminHtml(
          collaborators.map((item) => ({
            id: item.id,
            full_name: item.full_name,
            email: item.email,
            status: item.status,
            collection_name: item.collection?.name ?? null,
            edition_size: item.collection?.edition_size ?? null,
            invitation_sent_at: item.invitation_sent_at,
            last_login_at: item.last_login_at
          }))
        )
      );
  });

  app.get("/admin/collaborators/new", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(buildCollaboratorCreateHtml());
  });

  app.post("/admin/collaborators", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const body = (req.body as Record<string, unknown> | null) ?? {};
    const values = {
      full_name: readSingleValue(body.full_name).trim(),
      email: normalizeEmail(body.email),
      collection_name: readSingleValue(body.collection_name).trim(),
      collection_slug: normalizeCollectionSlug(
        readSingleValue(body.collection_slug).trim() || readSingleValue(body.collection_name).trim()
      ),
      artist_name: readSingleValue(body.artist_name).trim(),
      edition_size: readSingleValue(body.edition_size).trim()
    };

    const editionSize = Number(values.edition_size);
    if (!values.full_name || !values.email || !values.collection_name || !values.collection_slug) {
      reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          buildCollaboratorCreateHtml({
            error: "Please fill in name, email, collection name, and a valid collection slug.",
            values
          })
        );
      return;
    }

    if (!Number.isInteger(editionSize) || editionSize <= 0) {
      reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          buildCollaboratorCreateHtml({
            error: "Edition size must be a whole number greater than zero.",
            values
          })
        );
      return;
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const collection = await tx.collection.create({
          data: {
            slug: values.collection_slug,
            name: values.collection_name,
            artist_name: values.artist_name || null,
            edition_size: editionSize,
            artworks_count: 1,
            status: "draft"
          }
        });

        const user = await tx.collaboratorUser.create({
          data: {
            email: values.email,
            full_name: values.full_name,
            collection_id: collection.id,
            status: CollaboratorStatus.invited,
            invited_by: env.adminBasicUser
          }
        });

        return { collection, user };
      });

      const invite = await issueCollaboratorInvite({
        userId: created.user.id,
        email: created.user.email,
        fullName: created.user.full_name,
        collectionName: created.collection.name
      });

      reply
        .code(200)
        .type("text/html; charset=utf-8")
        .send(
          buildCollaboratorSuccessHtml({
            fullName: created.user.full_name,
            email: created.user.email,
            collectionName: created.collection.name,
            collectionSlug: created.collection.slug,
            editionSize: created.collection.edition_size,
            inviteLink: invite.inviteLink,
            emailSent: invite.emailSent,
            emailReason: invite.emailReason
          })
        );
    } catch (error) {
      let message = "Unable to create collaborator right now.";
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = Array.isArray(error.meta?.target)
          ? error.meta?.target.join(",")
          : String(error.meta?.target ?? "");
        if (target.includes("email")) {
          message = "That email already belongs to another collaborator.";
        } else if (target.includes("slug")) {
          message = "That collection slug is already in use.";
        }
      }

      req.log.error({ err: error }, "Failed to create collaborator");
      reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          buildCollaboratorCreateHtml({
            error: message,
            values
          })
        );
    }
  });

  app.post("/admin/collaborators/:id/invite", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const params = req.params as { id: string };
    const user = await prisma.collaboratorUser.findUnique({
      where: { id: params.id },
      include: { collection: true }
    });

    if (!user || !user.collection) {
      reply.code(404).send("Collaborator not found");
      return;
    }

    const invite = await issueCollaboratorInvite({
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      collectionName: user.collection.name
    });

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildCollaboratorSuccessHtml({
          fullName: user.full_name,
          email: user.email,
          collectionName: user.collection.name,
          collectionSlug: user.collection.slug,
          editionSize: user.collection.edition_size,
          inviteLink: invite.inviteLink,
          emailSent: invite.emailSent,
          emailReason: invite.emailReason
        })
      );
  });

  app.get("/partner/login", async (req, reply) => {
    const auth = await getPartnerAuth(req);
    if (auth) {
      reply.redirect(302, "/partner");
      return;
    }

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(buildPartnerLoginHtml());
  });

  app.post("/partner/login", async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const email = normalizeEmail(body.email);
    const password = readSingleValue(body.password);

    const fail = () =>
      reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(buildPartnerLoginHtml({ error: "We couldn't sign you in with that email and password." }));

    if (!email || !password) {
      fail();
      return;
    }

    const user = await prisma.collaboratorUser.findUnique({
      where: { email },
      include: { collection: true }
    });

    if (!user || user.status !== CollaboratorStatus.active || !verifyPassword(password, user.password_hash)) {
      fail();
      return;
    }

    const session = await createCollaboratorSession(user.id);
    await prisma.collaboratorUser.update({
      where: { id: user.id },
      data: { last_login_at: new Date() }
    });
    setPartnerSessionCookie(reply, session.rawToken, session.expiresAt);
    reply.redirect(302, "/partner");
  });

  app.get("/partner/invite/:token", async (req, reply) => {
    const params = req.params as { token: string };
    const invite = await prisma.collaboratorInvite.findFirst({
      where: {
        token_hash: hashOpaqueToken(params.token),
        revoked_at: null
      },
      include: {
        user: {
          include: {
            collection: true
          }
        }
      }
    });

    if (!invite || invite.accepted_at || invite.expires_at <= new Date() || !invite.user.collection) {
      reply
        .code(410)
        .type("text/html; charset=utf-8")
        .send(
          buildPartnerShell(
            "Invite expired • IRIS Partner Portal",
            `
              <div class="shell">
                <section class="hero">
                  <div class="eyebrow">IRIS Partner Portal</div>
                  <h1>Invite unavailable.</h1>
                  <p>This invitation link is expired or has already been used.</p>
                </section>
                <section class="body">
                  <h2>Need help?</h2>
                  <p>Please ask the IRIS team to resend your collaborator invite, or sign in if your password is already set.</p>
                  <a class="btn" href="/partner/login" style="display:inline-block;text-decoration:none;">Go to Sign In</a>
                </section>
              </div>
            `
          )
        );
      return;
    }

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildPartnerInviteHtml({
          fullName: invite.user.full_name,
          collectionName: invite.user.collection.name
        })
      );
  });

  app.post("/partner/invite/:token", async (req, reply) => {
    const params = req.params as { token: string };
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const password = readSingleValue(body.password);
    const passwordConfirm = readSingleValue(body.password_confirm);

    const invite = await prisma.collaboratorInvite.findFirst({
      where: {
        token_hash: hashOpaqueToken(params.token),
        revoked_at: null
      },
      include: {
        user: {
          include: {
            collection: true
          }
        }
      }
    });

    if (!invite || invite.accepted_at || invite.expires_at <= new Date() || !invite.user.collection) {
      reply
        .code(410)
        .type("text/html; charset=utf-8")
        .send(
          buildPartnerShell(
            "Invite expired • IRIS Partner Portal",
            `
              <div class="shell">
                <section class="hero">
                  <div class="eyebrow">IRIS Partner Portal</div>
                  <h1>Invite unavailable.</h1>
                  <p>This invitation link is expired or has already been used.</p>
                </section>
                <section class="body">
                  <h2>Need help?</h2>
                  <p>Please ask the IRIS team to resend your collaborator invite.</p>
                </section>
              </div>
            `
          )
        );
      return;
    }

    if (password.length < 10) {
      reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          buildPartnerInviteHtml({
            fullName: invite.user.full_name,
            collectionName: invite.user.collection.name,
            error: "Use at least 10 characters for your password."
          })
        );
      return;
    }

    if (password !== passwordConfirm) {
      reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          buildPartnerInviteHtml({
            fullName: invite.user.full_name,
            collectionName: invite.user.collection.name,
            error: "Password confirmation doesn't match."
          })
        );
      return;
    }

    const hashedPassword = hashPassword(password);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.collaboratorInvite.update({
        where: { id: invite.id },
        data: { accepted_at: now }
      });

      await tx.collaboratorUser.update({
        where: { id: invite.user.id },
        data: {
          password_hash: hashedPassword,
          status: CollaboratorStatus.active,
          last_login_at: now
        }
      });
    });

    const session = await createCollaboratorSession(invite.user.id);
    setPartnerSessionCookie(reply, session.rawToken, session.expiresAt);
    reply.redirect(302, "/partner");
  });

  app.get("/partner", async (req, reply) => {
    const session = await requireCollaborator(req, reply);
    if (!session) return;

    const collection = session.user.collection;
    const revealedCount = collection?.id
      ? await prisma.artwork.count({
          where: {
            collection_id: collection.id,
            status: "activated"
          }
        })
      : 0;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildPartnerDashboardHtml({
          fullName: session.user.full_name,
          email: session.user.email,
          collectionName: collection?.name ?? "Untitled collection",
          editionSize: collection?.edition_size ?? 0,
          collectionStatus: collection?.status ? collection.status.toString() : "draft",
          revealedCount
        })
      );
  });

  app.get("/partner/logout", async (req, reply) => {
    const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
    const rawToken = cookies[PARTNER_SESSION_COOKIE];
    if (rawToken) {
      await prisma.collaboratorSession.deleteMany({
        where: {
          token_hash: hashOpaqueToken(rawToken)
        }
      });
    }
    clearPartnerSessionCookie(reply);
    reply.redirect(302, "/partner/login");
  });

  app.get("/admin/customers/:email", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const params = req.params as { email: string };
    const email = normalizeEmail(decodeURIComponent(params.email || ""));
    if (!isValidEmail(email)) {
      reply.code(400).type("text/plain; charset=utf-8").send("Invalid customer email");
      return;
    }

    const [shopifyOrders, assignedArtworks] = await Promise.all([
      prisma.shopifyOrder.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: {
          id: true,
          shopify_order_id: true,
          order_name: true,
          order_number: true,
          email: true,
          financial_status: true,
          fulfillment_status: true,
          currency: true,
          total_price_cents: true,
          processed_at: true,
          created_at_shopify: true,
          updated_at_shopify: true,
          raw_json: true,
          created_at: true
        },
        orderBy: [{ created_at_shopify: "desc" }, { processed_at: "desc" }, { created_at: "desc" }],
        take: 500
      }),
      prisma.artwork.findMany({
        where: {
          OR: [
            { assigned_customer_email: { equals: email, mode: "insensitive" } },
            { owner_email: { equals: email, mode: "insensitive" } }
          ]
        },
        include: {
          collection: {
            select: {
              slug: true,
              edition_size: true
            }
          }
        },
        orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
        take: 1000
      })
    ]);

    const assignedEvents = await prisma.event.findMany({
      where: {
        iris_id: { in: assignedArtworks.map((item) => item.iris_id) },
        type: "assigned"
      },
      orderBy: { created_at: "desc" }
    });
    const assignedEventByIrisId = new Map<string, (typeof assignedEvents)[number]>();
    for (const event of assignedEvents) {
      if (!assignedEventByIrisId.has(event.iris_id)) {
        assignedEventByIrisId.set(event.iris_id, event);
      }
    }

    const artworkViewsById = await buildAdminOrderArtworkViewsById(assignedArtworks);
    const artworkByOrderKey = new Map<string, AdminOrderArtworkView[]>();
    for (const item of assignedArtworks) {
      const artworkView = artworkViewsById.get(item.iris_id);
      if (!artworkView) continue;
      for (const key of collectAdminOrderAliasKeys(item.assigned_order_id)) {
        const list = artworkByOrderKey.get(key) ?? [];
        if (!list.some((existing) => existing.iris_id === artworkView.iris_id)) {
          list.push(artworkView);
        }
        artworkByOrderKey.set(key, list);
      }
    }

    const knownShopifyOrderKeys = new Set<string>();
    const rows: AdminOrderView[] = shopifyOrders.map((order) => {
      const lookupKeys = collectOrderLookupKeys(order);
      lookupKeys.forEach((key) => knownShopifyOrderKeys.add(key));
      const artworks = lookupKeys.flatMap((key) => artworkByOrderKey.get(key) ?? []);
      return {
        key: order.order_name ?? order.order_number ?? order.shopify_order_id ?? order.id,
        lookup_keys: lookupKeys,
        order_name: order.order_name,
        order_number: order.order_number,
        order_date: getAdminOrderDate(order),
        customer_name: extractAdminOrderCustomerName(order.raw_json),
        email: order.email ?? email,
        total_order_count: null,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        currency: order.currency,
        total_price_cents: order.total_price_cents,
        artworks: Array.from(new Map(artworks.map((item) => [item.iris_id, item])).values())
      };
    });

    const legacyGroups = new Map<string, typeof assignedArtworks>();
    for (const item of assignedArtworks) {
      if (normalizeEmail(item.assigned_customer_email) !== email) continue;
      const lookupKeys = collectAdminOrderAliasKeys(item.assigned_order_id);
      if (lookupKeys.length === 0 || lookupKeys.some((key) => knownShopifyOrderKeys.has(key))) continue;
      const key = lookupKeys[0];
      const list = legacyGroups.get(key) ?? [];
      list.push(item);
      legacyGroups.set(key, list);
    }

    for (const [key, items] of legacyGroups) {
      const first = items[0];
      const firstEvent = first ? assignedEventByIrisId.get(first.iris_id) : null;
      const orderDate = firstEvent ? extractAssignedEventOrderDate(firstEvent) : first?.updated_at ?? null;
      const artworks = items
        .map((item) => artworkViewsById.get(item.iris_id))
        .filter((item): item is AdminOrderArtworkView => Boolean(item));
      rows.push({
        key,
        lookup_keys: collectAdminOrderAliasKeys(first?.assigned_order_id ?? key),
        order_name: first?.assigned_order_id ?? key,
        order_number: first?.assigned_order_id?.replace(/^#/, "") ?? null,
        order_date: orderDate,
        customer_name: null,
        email,
        total_order_count: null,
        financial_status: null,
        fulfillment_status: null,
        currency: null,
        total_price_cents: null,
        artworks
      });
    }

    rows.sort((a, b) => {
      const dateDiff = adminOrderSortValue(b.order_date) - adminOrderSortValue(a.order_date);
      if (dateDiff !== 0) return dateDiff;
      const numberA = Number((a.order_number ?? a.order_name ?? "").replace(/\D/g, ""));
      const numberB = Number((b.order_number ?? b.order_name ?? "").replace(/\D/g, ""));
      if (Number.isFinite(numberA) && Number.isFinite(numberB) && numberA !== numberB) {
        return numberB - numberA;
      }
      return formatAdminOrderTitle(b).localeCompare(formatAdminOrderTitle(a));
    });

    const totalOrderCount = await countAdminCustomerOrdersByEmail(email);
    const customerName = shopifyOrders.map((order) => extractAdminOrderCustomerName(order.raw_json)).find(Boolean) ?? null;
    const artworks = Array.from(new Map(Array.from(artworkViewsById.values()).map((item) => [item.iris_id, item])).values()).sort(
      (a, b) => b.iris_id.localeCompare(a.iris_id)
    );

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminCustomerHtml({
          email,
          customer_name: customerName,
          total_order_count: totalOrderCount,
          orders: rows.map((row) => ({ ...row, total_order_count: totalOrderCount })),
          artworks
        })
      );
  });

  app.get("/admin/orders", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const query = req.query as { q?: string; page?: string };
    const q = query.q?.trim();
    const page = Math.max(1, Number(query.page ?? 1));
    const take = 20;
    const fetchLimit = q ? 600 : Math.max(600, page * take + take + 80);

    const artworkWhere: Prisma.ArtworkWhereInput = {
      assigned_order_id: { not: null }
    };
    if (q) {
      artworkWhere.OR = [
        { iris_id: { contains: q, mode: "insensitive" } },
        { assigned_order_id: { contains: q, mode: "insensitive" } },
        { assigned_customer_email: { contains: q, mode: "insensitive" } },
        { owner_email: { contains: q, mode: "insensitive" } }
      ];
    }

    const assignedArtworks = await prisma.artwork.findMany({
      where: artworkWhere,
      include: {
        collection: {
          select: {
            slug: true,
            edition_size: true
          }
        }
      },
      orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
      take: fetchLimit
    });

    const assignmentOrderValues = Array.from(
      new Set(assignedArtworks.map((item) => item.assigned_order_id).filter((value): value is string => Boolean(value)))
    );

    const shopifyOrderWhere: Prisma.ShopifyOrderWhereInput = {};
    if (q) {
      const matchedAssignmentOrderFilters = assignmentOrderValues.flatMap((value) =>
        buildOrderLookupValues(value).flatMap((variant) => [
          { order_name: { equals: variant, mode: "insensitive" as const } },
          { order_number: { equals: variant.replace(/^#/, ""), mode: "insensitive" as const } },
          { shopify_order_id: { equals: variant, mode: "insensitive" as const } }
        ])
      );
      shopifyOrderWhere.OR = [
        { order_name: { contains: q, mode: "insensitive" } },
        { order_number: { contains: q.replace(/^#/, ""), mode: "insensitive" } },
        { shopify_order_id: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        ...matchedAssignmentOrderFilters
      ];
    }

    const shopifyOrders = await prisma.shopifyOrder.findMany({
      where: shopifyOrderWhere,
      select: {
        id: true,
        shopify_order_id: true,
        order_name: true,
        order_number: true,
        email: true,
        financial_status: true,
        fulfillment_status: true,
        currency: true,
        total_price_cents: true,
        processed_at: true,
        created_at_shopify: true,
        updated_at_shopify: true,
        raw_json: true,
        created_at: true
      },
      orderBy: [{ created_at_shopify: "desc" }, { processed_at: "desc" }, { created_at: "desc" }],
      take: fetchLimit
    });

    const assignedEvents = await prisma.event.findMany({
      where: {
        iris_id: { in: assignedArtworks.map((item) => item.iris_id) },
        type: "assigned"
      },
      orderBy: { created_at: "desc" }
    });
    const assignedEventByIrisId = new Map<string, (typeof assignedEvents)[number]>();
    for (const event of assignedEvents) {
      if (!assignedEventByIrisId.has(event.iris_id)) {
        assignedEventByIrisId.set(event.iris_id, event);
      }
    }

    const artworkViewsById = await buildAdminOrderArtworkViewsById(assignedArtworks);

    const artworkByOrderKey = new Map<string, AdminOrderArtworkView[]>();
    for (const item of assignedArtworks) {
      const artworkView = artworkViewsById.get(item.iris_id);
      if (!artworkView) continue;
      for (const key of buildOrderLookupValues(item.assigned_order_id).map(normalizeOrderLookupKey).filter(Boolean)) {
        const list = artworkByOrderKey.get(key) ?? [];
        if (!list.some((existing) => existing.iris_id === artworkView.iris_id)) {
          list.push(artworkView);
        }
        artworkByOrderKey.set(key, list);
      }
    }

    const knownShopifyOrderKeys = new Set<string>();
    const rows: AdminOrderView[] = shopifyOrders.map((order) => {
      const lookupKeys = collectOrderLookupKeys(order);
      lookupKeys.forEach((key) => knownShopifyOrderKeys.add(key));
      const artworks = lookupKeys.flatMap((key) => artworkByOrderKey.get(key) ?? []);
      return {
        key: order.order_name ?? order.order_number ?? order.shopify_order_id ?? order.id,
        lookup_keys: lookupKeys,
        order_name: order.order_name,
        order_number: order.order_number,
        order_date: getAdminOrderDate(order),
        customer_name: extractAdminOrderCustomerName(order.raw_json),
        email: order.email,
        total_order_count: null,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        currency: order.currency,
        total_price_cents: order.total_price_cents,
        artworks: Array.from(new Map(artworks.map((item) => [item.iris_id, item])).values())
      };
    });

    const legacyGroups = new Map<string, typeof assignedArtworks>();
    for (const item of assignedArtworks) {
      const lookupKeys = buildOrderLookupValues(item.assigned_order_id).map(normalizeOrderLookupKey).filter(Boolean);
      if (lookupKeys.length === 0 || lookupKeys.some((key) => knownShopifyOrderKeys.has(key))) {
        continue;
      }
      const key = lookupKeys[0];
      const list = legacyGroups.get(key) ?? [];
      list.push(item);
      legacyGroups.set(key, list);
    }

    for (const [key, items] of legacyGroups) {
      const first = items[0];
      const firstEvent = first ? assignedEventByIrisId.get(first.iris_id) : null;
      const orderDate = firstEvent ? extractAssignedEventOrderDate(firstEvent) : first?.updated_at ?? null;
      const email = first?.assigned_customer_email ?? null;
      const artworks = items
        .map((item) => artworkViewsById.get(item.iris_id))
        .filter((item): item is AdminOrderArtworkView => Boolean(item));
      rows.push({
        key,
        lookup_keys: buildOrderLookupValues(first?.assigned_order_id ?? key).map(normalizeOrderLookupKey).filter(Boolean),
        order_name: first?.assigned_order_id ?? key,
        order_number: first?.assigned_order_id?.replace(/^#/, "") ?? null,
        order_date: orderDate,
        customer_name: null,
        email,
        total_order_count: null,
        financial_status: null,
        fulfillment_status: null,
        currency: null,
        total_price_cents: null,
        artworks
      });
    }

    rows.sort((a, b) => {
      const dateDiff = adminOrderSortValue(b.order_date) - adminOrderSortValue(a.order_date);
      if (dateDiff !== 0) return dateDiff;
      const numberA = Number((a.order_number ?? a.order_name ?? "").replace(/\D/g, ""));
      const numberB = Number((b.order_number ?? b.order_name ?? "").replace(/\D/g, ""));
      if (Number.isFinite(numberA) && Number.isFinite(numberB) && numberA !== numberB) {
        return numberB - numberA;
      }
      return formatAdminOrderTitle(b).localeCompare(formatAdminOrderTitle(a));
    });

    const start = (page - 1) * take;
    const pageRows = rows.slice(start, start + take);
    const totalOrderCountsByEmail = await loadAdminTotalOrderCountsByEmail(
      pageRows.map((row) => row.email).filter((value): value is string => Boolean(value))
    );
    const pageRowsWithCounts = pageRows.map((row) => {
      const normalizedEmail = row.email ? normalizeEmail(row.email) : null;
      return normalizedEmail
        ? {
            ...row,
            total_order_count: totalOrderCountsByEmail.get(normalizedEmail) ?? row.total_order_count
          }
        : row;
    });
    const hasNext = rows.length > start + take;
    const hasPrev = page > 1;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(buildAdminOrdersHtml(pageRowsWithCounts, q ?? "", page, hasPrev, hasNext));
  });

  app.get("/admin", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const query = req.query as { q?: string; page?: string; status?: string };
    const q = query.q?.trim();
    const statusParam = query.status?.toLowerCase() ?? "all";
    const statuses: ArtworkStatus[] =
      statusParam === "activated"
        ? ["activated"]
        : statusParam === "unactivated"
          ? ["assigned", "shopify_failed"]
          : ["assigned", "activated", "shopify_failed"];
    const where: Prisma.ArtworkWhereInput = {
      status: { in: statuses }
    };

    if (q) {
      where.OR = [
        { iris_id: { contains: q, mode: "insensitive" } },
        { assigned_order_id: { contains: q, mode: "insensitive" } },
        { owner_email: { contains: q, mode: "insensitive" } }
      ];
    }

    const page = Math.max(1, Number(query.page ?? 1));
    const take = 20;
    const fetchLimit = Math.max(12000, page * take + take + 1);

    const items = await prisma.artwork.findMany({
      where,
      orderBy: [{ iris_id: "desc" }],
      take: fetchLimit,
      include: {
        collection: {
          select: {
            slug: true,
            edition_size: true
          }
        }
      }
    });

    const itemIds = items.map((item) => item.iris_id);
    const orderEvents = itemIds.length
      ? await prisma.event.findMany({
          where: { iris_id: { in: itemIds }, type: "assigned" },
          orderBy: { created_at: "desc" }
        })
      : [];
    const orderDateById = new Map<string, Date>();
    for (const event of orderEvents) {
      if (!orderDateById.has(event.iris_id)) {
        orderDateById.set(event.iris_id, extractAssignedEventOrderDate(event));
      }
    }
    for (const item of items) {
      if (!orderDateById.has(item.iris_id)) {
        orderDateById.set(item.iris_id, item.created_at);
      }
    }

    items.sort((a, b) => compareAdminArchiveItemsByOrderDate(a, b, orderDateById));

    const start = (page - 1) * take;
    const slice = items.slice(start, start + take);
    const hasNext = items.length > start + take;
    const hasPrev = page > 1;
    const pendingTransfersByIrisId = await getPendingTransfersByIrisId(slice.map((item) => item.iris_id));

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminAllHtml(
          slice.map((item) => ({
            iris_id: item.iris_id,
            display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
            status: pendingTransfersByIrisId.has(item.iris_id) ? "pending_transfer" : item.status,
            order_date: orderDateById.get(item.iris_id) ?? null,
            owner_email: item.owner_email,
            activated_at: item.activated_at,
            image_url: item.image_url,
            pin_code: item.pin_code,
            weight_grams: item.weight_grams,
            rarity_code: item.rarity_code
          })),
          q ?? "",
          statusParam,
          page,
          hasPrev,
          hasNext
        )
      );
  });

  app.get("/admin/activities", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const query = req.query as { status?: string; q?: string; page?: string };
    const statusParam = query.status?.toLowerCase() ?? "all";
    const statuses: ArtworkStatus[] =
      statusParam === "activated"
        ? ["activated"]
        : statusParam === "unactivated"
          ? ["assigned", "shopify_failed"]
          : ["assigned", "activated", "shopify_failed"];

    const where: Prisma.ArtworkWhereInput = {
      status: { in: statuses }
    };

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { iris_id: { contains: q, mode: "insensitive" } },
        { assigned_order_id: { contains: q, mode: "insensitive" } },
        { assigned_customer_email: { contains: q, mode: "insensitive" } }
      ];
    }

    const page = Math.max(1, Number(query.page ?? 1));
    const take = 20;
    const skip = (page - 1) * take;

    const items = await prisma.artwork.findMany({
      where,
      orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
      skip,
      take: take + 1,
      include: {
        collection: {
          select: {
            slug: true,
            edition_size: true
          }
        }
      }
    });

    const orderEvents = await prisma.event.findMany({
      where: { iris_id: { in: items.map((i) => i.iris_id) }, type: "assigned" },
      orderBy: { created_at: "desc" }
    });
    const orderDateById = new Map<string, Date>();
    for (const ev of orderEvents) {
      if (!orderDateById.has(ev.iris_id)) {
        orderDateById.set(ev.iris_id, extractAssignedEventOrderDate(ev));
      }
    }

    const hasNext = items.length > take;
    const slice = hasNext ? items.slice(0, take) : items;
    const hasPrev = page > 1;
    const pendingTransfersByIrisId = await getPendingTransfersByIrisId(slice.map((item) => item.iris_id));

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminHtml(
          slice.map((item) => ({
            iris_id: item.iris_id,
            display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
            status: pendingTransfersByIrisId.has(item.iris_id) ? "pending_transfer" : item.status,
            assigned_order_id: item.assigned_order_id,
            assigned_customer_email: item.assigned_customer_email,
            order_date: orderDateById.get(item.iris_id) ?? null,
            image_url: item.image_url,
            pin_code: item.pin_code
          })),
          q ?? "",
          statusParam,
          page,
          hasPrev,
          hasNext
        )
      );
  });

  app.get("/admin/all", async (_req, reply) => {
    reply.redirect(302, "/admin");
  });

  app.get("/admin/activation-logs", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const page = Math.max(1, Number((req.query as { page?: string })?.page ?? 1));
    const take = 20;
    const skip = (page - 1) * take;

    const items = await prisma.event.findMany({
      where: { type: { in: ["activated", "activation_failed", "activation_blocked"] } },
      orderBy: { created_at: "desc" },
      skip,
      take: take + 1
    });

    const hasNext = items.length > take;
    const slice = hasNext ? items.slice(0, take) : items;
    const hasPrev = page > 1;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildActivationLogsHtml(
          slice.map((item) => ({
            iris_id: item.iris_id,
            type: item.type,
            created_at: item.created_at
          })),
          page,
          hasPrev,
          hasNext
        )
      );
  });

  app.get("/admin/iris/:irisId", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const params = req.params as { irisId: string };
    const irisId = sanitizeIrisId(params.irisId);
    if (!irisId) {
      reply.code(400).send("Invalid iris_id");
      return;
    }
    let item = await prisma.artwork.findUnique({
      where: { iris_id: irisId },
      include: {
        collection: {
          select: {
            slug: true,
            edition_size: true
          }
        }
      }
    });
    if (!item) {
      reply.code(404).send("Not found");
      return;
    }
    if (!item.activation_token) {
      item = await prisma.artwork.update({
        where: { iris_id: irisId },
        data: { activation_token: generateActivationToken() },
        include: {
          collection: {
            select: {
              slug: true,
              edition_size: true
            }
          }
        }
      });
    }
    const assignedEvent = await prisma.event.findFirst({
      where: { iris_id: item.iris_id, type: "assigned" },
      orderBy: { created_at: "desc" }
    });
    const pendingTransfersByIrisId = await getPendingTransfersByIrisId([item.iris_id]);
    const archiveNavigationItems = await prisma.artwork.findMany({
      where: {
        status: { in: ["assigned", "activated", "shopify_failed"] }
      },
      select: {
        iris_id: true,
        assigned_order_id: true,
        created_at: true
      },
      orderBy: [{ iris_id: "desc" }],
      take: 12000
    });
    const archiveNavigationEvents = archiveNavigationItems.length
      ? await prisma.event.findMany({
          where: { iris_id: { in: archiveNavigationItems.map((navItem) => navItem.iris_id) }, type: "assigned" },
          orderBy: { created_at: "desc" }
        })
      : [];
    const archiveNavigationOrderDateById = new Map<string, Date>();
    for (const event of archiveNavigationEvents) {
      if (!archiveNavigationOrderDateById.has(event.iris_id)) {
        archiveNavigationOrderDateById.set(event.iris_id, extractAssignedEventOrderDate(event));
      }
    }
    for (const navItem of archiveNavigationItems) {
      if (!archiveNavigationOrderDateById.has(navItem.iris_id)) {
        archiveNavigationOrderDateById.set(navItem.iris_id, navItem.created_at);
      }
    }
    archiveNavigationItems.sort((a, b) =>
      compareAdminArchiveItemsByOrderDate(a, b, archiveNavigationOrderDateById)
    );
    const archiveIndex = archiveNavigationItems.findIndex((navItem) => navItem.iris_id === item.iris_id);
    const previousIrisId = archiveIndex > 0 ? archiveNavigationItems[archiveIndex - 1]?.iris_id ?? null : null;
    const nextIrisId =
      archiveIndex >= 0 && archiveIndex < archiveNavigationItems.length - 1
        ? archiveNavigationItems[archiveIndex + 1]?.iris_id ?? null
        : null;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminDetailHtml({
          iris_id: item.iris_id,
          display_iris_id: formatDisplayIrisId(item.iris_id, item.collection),
          status: pendingTransfersByIrisId.has(item.iris_id) ? "pending_transfer" : item.status,
          rarity_code: item.rarity_code,
          weight_grams: item.weight_grams,
          assigned_order_id: item.assigned_order_id,
          assigned_customer_email: item.assigned_customer_email,
          owner_email: item.owner_email,
          activated_at: item.activated_at,
          order_date: assignedEvent ? extractAssignedEventOrderDate(assignedEvent) : null,
          image_url: item.image_url,
          pin_code: item.pin_code,
          activation_token: item.activation_token,
          previous_iris_id: previousIrisId,
          next_iris_id: nextIrisId
        })
      );
  });

  app.get("/admin/logout", async (_req, reply) => {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="IRIS Admin"')
      .send("Logged out");
  });

  app.post("/admin/iris/upload", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const data = await (req as any).file();
    if (!data) {
      reply.code(400).send("Missing file");
      return;
    }

    const irisIdRaw = data.fields?.iris_id?.value;
    if (!irisIdRaw || typeof irisIdRaw !== "string") {
      reply.code(400).send("Missing iris_id");
      return;
    }

    const irisId = sanitizeIrisId(irisIdRaw);
    if (!irisId) {
      reply.code(400).send("Invalid iris_id");
      return;
    }

    const ext = path.extname(data.filename || "").toLowerCase() || ".jpg";
    const objectKey = `iris/${irisId}/${Date.now()}-${crypto.randomUUID()}${ext}`;

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    await r2.send(
      new PutObjectCommand({
        Bucket: env.r2Bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: data.mimetype || "application/octet-stream"
      })
    );

    const publicBase = env.r2PublicBaseUrl.replace(/\/$/, "");
    const imageUrl = `${publicBase}/${objectKey}`;

    await prisma.artwork.update({
      where: { iris_id: irisId },
      data: { image_url: imageUrl }
    });

    const referer = (req.headers.referer || req.headers.referrer || "") as string;
    if (referer.includes(`/admin/iris/${irisId}`)) {
      reply.redirect(303, referer);
      return;
    }
    reply.redirect(303, `/admin/iris/${encodeURIComponent(irisId)}`);
  });

  app.post("/admin/iris/weight", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = req.body as { iris_id?: string; weight_grams?: string };
    const irisId = body.iris_id ? sanitizeIrisId(body.iris_id) : "";
    if (!irisId) {
      reply.code(400).send("Missing iris_id");
      return;
    }
    const weightRaw = body.weight_grams?.trim();
    let weight: number | null = null;
    if (weightRaw) {
      const parsed = Number(weightRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        reply.code(400).send("Invalid weight");
        return;
      }
      weight = parsed;
    }
    await prisma.artwork.update({
      where: { iris_id: irisId },
      data: { weight_grams: weight }
    });
    reply.redirect(303, `/admin/iris/${encodeURIComponent(irisId)}`);
  });

  app.setErrorHandler((error, _req, reply) => {
    app.log.error({ err: error }, "Unhandled error");
    sendJson(reply, 500, { error: "internal_error" });
  });

  const intervalMs = env.releaseIntervalMinutes * 60 * 1000;
  const interval = setInterval(() => void releaseExpiredReservations(app), intervalMs);
  interval.unref();

  app.addHook("onClose", async () => {
    clearInterval(interval);
    await prisma.$disconnect();
  });

  return app;
};
