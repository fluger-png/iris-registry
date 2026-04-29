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
let goldCache: { price: number; ts: number } | null = null;

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
const PARTNER_PASSWORD_KEYLEN = 64;

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
    assigned: { bg: "#FFF9D5", fg: "#D8C029", label: "Assigned" },
    shopify_failed: { bg: "#FEE2E2", fg: "#991B1B", label: "Shopify Failed" }
  };
  const style = map[key] ?? { bg: "#E5E7EB", fg: "#374151", label: status };
  return `<span class="pill" style="background:${style.bg};color:${style.fg};">${style.label}</span>`;
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
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.iris_id}</a></td>
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
    status: string;
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
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.iris_id}</a></td>
          <td>${statusPill(item.status)}</td>
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
          ${rows || "<tr><td colspan='9'>No records</td></tr>"}
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

  const buildAdminDetailHtml = (item: {
  iris_id: string;
  status: string;
  rarity_code: string | null;
  weight_grams: number | null;
  assigned_order_id: string | null;
  assigned_customer_email: string | null;
  owner_email: string | null;
  activated_at: Date | null;
  created_at: Date;
  image_url: string | null;
  pin_code: string | null;
  activation_token: string | null;
}) => {
  const displayId = item.iris_id.toUpperCase().startsWith("IRIS-")
    ? item.iris_id.replace(/^IRIS-/i, "#")
    : item.iris_id;
    const activationToken = item.activation_token ? item.activation_token : null;
    const activationLink = activationToken
      ? `${env.baseStorefrontUrl}/pages/activate?token=${activationToken}`
      : `${env.baseStorefrontUrl}/pages/activate?iris=${item.iris_id}`;
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
        <h2>IRIS ${displayId}</h2>
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
          <dt>Order Date</dt><dd>${new Date(item.created_at).toISOString().slice(0, 10)}</dd>
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
  return buildAdminShell(`IRIS ${item.iris_id}`, body, "", "all");
};

const extractCustomerEmail = (order: Record<string, unknown>): string | null => {
  const email = order.email;
  if (typeof email === "string" && email.trim()) {
    return email.trim();
  }
  const customer = order.customer as Record<string, unknown> | undefined;
  const customerEmail = customer?.email;
  if (typeof customerEmail === "string" && customerEmail.trim()) {
    return customerEmail.trim();
  }
  return null;
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

const isCoreCollectionAlias = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return CORE_COLLECTION_ALIASES.has(normalizeCollectionSlug(value));
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
      irisId: reservation.iris_id,
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
    const customerEmail = extractCustomerEmail(order);
    const failed: Array<{ token: string; error: string }> = [];
    const collectionLookupCache = new Map<string, Awaited<ReturnType<typeof resolveCollection>>>();

    const resolveLineItemCollection = async (productId: string | null, productHandle: string | null) => {
      const cacheKey = `${productId ?? ""}|${productHandle ?? ""}`;
      if (collectionLookupCache.has(cacheKey)) {
        return collectionLookupCache.get(cacheKey) ?? null;
      }
      const collection = await resolveCollection({ productId, productHandle });
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

    const assignFromCollection = async (
      collection: { id: string; slug: string; name: string },
      lineItem: { productId: string | null; handle: string | null; quantity: number }
    ) => {
      let assignedIrisId: string | null = null;
      let generatedPin: string | null = null;

      await prisma.$transaction(async (tx) => {
        const irisId = await pickAvailableArtwork(tx, {
          mode: "collection",
          collectionId: collection.id
        });
        if (!irisId) {
          throw new Error(`no_available_artwork:${collection.slug}`);
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
              customer_email: customerEmail,
              collection_slug: collection.slug,
              collection_name: collection.name,
              source: "product_mapping",
              shopify_product_id: lineItem.productId,
              shopify_handle: lineItem.handle
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

    const mappedAssignments = [] as Array<{
      collection: { id: string; slug: string; name: string };
      lineItem: { productId: string | null; handle: string | null; quantity: number };
    }>;

    for (const item of lineItems) {
      if (item.reservationTokens.length >= item.quantity) {
        continue;
      }
      const collection = await resolveLineItemCollection(item.productId, item.handle);
      if (!collection) {
        continue;
      }
      const missingCount = item.quantity - item.reservationTokens.length;
      for (let index = 0; index < missingCount; index += 1) {
        mappedAssignments.push({ collection, lineItem: item });
      }
    }

    if (reservationTokens.length === 0 && mappedAssignments.length === 0) {
      reply.code(400).send({ error: "missing_reservation_token" });
      return;
    }

    try {
      for (const token of reservationTokens) {
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
      for (const assignment of mappedAssignments) {
        await assignFromCollection(assignment.collection, assignment.lineItem);
      }
    } catch (error) {
      req.log.error({ err: error }, "Failed to confirm reservation");
      reply.code(500).send({ error: "reservation_confirm_failed" });
      return;
    }

    if (failed.length > 0) {
      req.log.warn({ failed, orderId }, "Some reservations failed to confirm");
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
    const body = req.body as { iris_id?: string; pin?: string; email?: string; token?: string };
    let irisId = body?.iris_id?.toUpperCase().trim() ?? "";
    let token = body?.token?.trim() ?? "";
    const tokenMatch = irisId.match(/^IRIS-\d{4}-(.+)$/i);
    if (tokenMatch) {
      irisId = irisId.slice(0, 9);
      if (!token) token = tokenMatch[1];
    }
    const pin = body?.pin?.trim();
    const email = body?.email?.trim().toLowerCase();

    if ((!irisId && !token) || !pin || !email) {
      sendJson(reply, 400, { error: "missing_required_fields" });
      return;
    }

    const MAX_ATTEMPTS = 4;
    const LOCK_MINUTES = 60;

    try {
      let artwork = irisId ? await prisma.artwork.findUnique({ where: { iris_id: irisId } }) : null;
      if (!artwork && token) {
        artwork = await prisma.artwork.findUnique({ where: { activation_token: token } });
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

      await prisma.$transaction(async (tx) => {
        await tx.artwork.update({
          where: { iris_id: irisId },
          data: {
            status: "activated",
            activated_at: new Date(),
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

      try {
        await ensureShopifyCustomerInvite(email);
      } catch (inviteErr) {
        req.log.error({ err: inviteErr, email }, "Shopify invite failed");
      }

      sendJson(reply, 200, { status: "ok" });
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
            name: true
          }
        }
      }
    });
    if (!artwork) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.send({
      iris_id: artwork.iris_id,
      image_url: artwork.image_url,
      status: artwork.status,
      activated_at: artwork.activated_at,
      rarity_code: artwork.rarity_code,
      weight_grams: artwork.weight_grams,
      collection: artwork.collection
    });
  });

  app.get("/apps/iris/seen-archive", async (req, reply) => {
    const query = req.query as { limit?: string; cursor?: string; rarity?: string; collection?: string };
    const limit = parseLimit(query.limit, 20);

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
            { updated_at: { lt: sortAt } },
            { updated_at: sortAt, iris_id: { lt: cursor.irisId } }
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
        orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
        take: limit + 1,
        include: {
          collection: {
            select: {
              slug: true,
              name: true
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
    const nextCursor = hasMore
      ? encodeCursor({
          sortAt: slice[slice.length - 1].updated_at.toISOString(),
          irisId: slice[slice.length - 1].iris_id
        })
      : null;

    sendJson(reply, 200, {
      items: slice.map((item) => ({
        iris_id: item.iris_id,
        status: item.status,
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        activated_at: item.activated_at,
        weight_grams: item.weight_grams,
        collection: item.collection
      })),
      nextCursor,
      total_count: totalCount,
      collection: collectionMeta
    });
  });

  app.get("/apps/iris/my-iris", async (req, reply) => {
    const query = req.query as { email?: string };
    if (!query.email) {
      sendJson(reply, 400, { error: "missing_email" });
      return;
    }

    const items = await prisma.artwork.findMany({
      where: {
        status: "activated",
        OR: [
          { owner_email: query.email },
          { owner_email: null, assigned_customer_email: query.email }
        ]
      },
      orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }],
      include: {
        collection: {
          select: {
            slug: true,
            name: true
          }
        }
      }
    });

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
      items: items.map((item) => ({
        iris_id: item.iris_id,
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        activated_at: item.activated_at,
        collection: item.collection,
        passport_url: (item.proof_token ?? generatedTokens.get(item.iris_id))
          ? `/pages/iris-passport?iris_id=${encodeURIComponent(item.iris_id)}&token=${encodeURIComponent(
              item.proof_token ?? generatedTokens.get(item.iris_id) ?? ""
            )}`
          : `/pages/iris-passport?iris_id=${encodeURIComponent(item.iris_id)}`
      }))
    });
  });

  app.get("/apps/iris/iris/:irisId", async (req, reply) => {
    const params = req.params as { irisId: string };
    const query = req.query as { token?: string };
    const irisId = sanitizeIrisId(params.irisId);
    if (!irisId) {
      sendJson(reply, 400, { error: "invalid_iris_id" });
      return;
    }

    const item = await prisma.artwork.findUnique({
      where: { iris_id: irisId },
      include: {
        collection: {
          select: {
            slug: true,
            name: true
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
    sendJson(reply, 200, {
      iris_id: item.iris_id,
      image_url: item.image_url,
      rarity_code: item.rarity_code,
      weight_grams: item.weight_grams,
      activated_at: item.activated_at,
      status: item.status,
      proof_url: proofPath,
      collection: item.collection
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
    if (!env.goldApiKey) {
      sendJson(reply, 503, { error: "gold_api_key_missing" });
      return;
    }

    const now = Date.now();
    if (goldCache && now - goldCache.ts < GOLD_CACHE_TTL_MS) {
      sendJson(reply, 200, { price_usd_g: goldCache.price, updated_at: new Date(goldCache.ts).toISOString() });
      return;
    }

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
      const data = (await res.json()) as { price_gram_24k?: number; price?: number };
      let perGram = data.price_gram_24k;
      if (!perGram && data.price) {
        perGram = data.price / 31.1034768;
      }
      if (!perGram || !Number.isFinite(perGram)) {
        throw new Error("goldapi_missing_price");
      }
      goldCache = { price: perGram, ts: now };
      sendJson(reply, 200, { price_usd_g: perGram, updated_at: new Date(now).toISOString() });
    } catch (err) {
      app.log.error({ err }, "Gold API fetch failed");
      sendJson(reply, 502, { error: "gold_api_failed" });
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
    const skip = (page - 1) * take;

    const items = await prisma.artwork.findMany({
      where,
      orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
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
        buildAdminAllHtml(
          slice.map((item) => ({
            iris_id: item.iris_id,
            status: item.status,
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
      take: take + 1
    });

    const orderEvents = await prisma.event.findMany({
      where: { iris_id: { in: items.map((i) => i.iris_id) }, type: "assigned" },
      orderBy: { created_at: "desc" }
    });
    const orderDateById = new Map<string, Date>();
    for (const ev of orderEvents) {
      if (!orderDateById.has(ev.iris_id)) {
        orderDateById.set(ev.iris_id, ev.created_at);
      }
    }

    const hasNext = items.length > take;
    const slice = hasNext ? items.slice(0, take) : items;
    const hasPrev = page > 1;

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminHtml(
          slice.map((item) => ({
            iris_id: item.iris_id,
            status: item.status,
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
      where: { iris_id: irisId }
    });
    if (!item) {
      reply.code(404).send("Not found");
      return;
    }
    if (!item.activation_token) {
      item = await prisma.artwork.update({
        where: { iris_id: irisId },
        data: { activation_token: generateActivationToken() }
      });
    }

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminDetailHtml({
          iris_id: item.iris_id,
          status: item.status,
          rarity_code: item.rarity_code,
          weight_grams: item.weight_grams,
          assigned_order_id: item.assigned_order_id,
          assigned_customer_email: item.assigned_customer_email,
          owner_email: item.owner_email,
          activated_at: item.activated_at,
          created_at: item.created_at,
          image_url: item.image_url,
          pin_code: item.pin_code,
          activation_token: item.activation_token
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
