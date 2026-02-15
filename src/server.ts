import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Prisma, ArtworkStatus } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import path from "node:path";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { decodeCursor, encodeCursor, parseReservationTokens, verifyShopifyHmac } from "./utils.js";
import { computeLeaf, verifyMerkleProof } from "./rarity.js";
import fs from "node:fs";

const MAX_PAGE_SIZE = 100;

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

const formatDate = (value: Date): string => {
  const d = new Date(value);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}.${dd}.${yy}`;
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

const buildAdminShell = (title: string, body: string, _searchValue: string, activeTab: string) => {
  const activitiesActive =
    activeTab === "activities" ||
    activeTab === "all" ||
    activeTab === "activated" ||
    activeTab === "unactivated";
  const allActive = activeTab === "all-iris";
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
          width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid var(--line);
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
            <a class="${activitiesActive ? "active" : ""}" href="/admin">Activities</a>
            <a class="${allActive ? "active" : ""}" href="/admin/all">All IRISes</a>
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
      const imageCell = item.image_url
        ? `<img class="thumb" src="${item.image_url}" alt="${item.iris_id}" />`
        : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#94A3B8;">—</div>`;
      const fileId = `file-${item.iris_id}`;
      return `
        <tr>
          <td><a class="iris-link" href="/admin/iris/${item.iris_id}">${item.iris_id}</a></td>
          <td>${statusPill(item.status)}</td>
          <td>${item.assigned_customer_email ?? "-"}</td>
          <td>${item.assigned_order_id ?? "-"}</td>
          <td>${item.order_date ? formatDate(item.order_date) : "-"}</td>
          <td>${item.pin_code ?? "-"}</td>
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

  const statusHidden = activeTab !== "all" ? `<input type="hidden" name="status" value="${activeTab}" />` : "";
  const baseParams = [
    activeTab !== "all" ? `status=${encodeURIComponent(activeTab)}` : "",
    searchValue ? `q=${encodeURIComponent(searchValue)}` : ""
  ].filter(Boolean);
  const prevParams = baseParams.concat(`page=${page - 1}`).join("&");
  const nextParams = baseParams.concat(`page=${page + 1}`).join("&");
  const prevHref = hasPrev ? `/admin?${prevParams}` : "#";
  const nextHref = hasNext ? `/admin?${nextParams}` : "#";

  const body = `
    <div class="title-row">
      <h1>Activities</h1>
      <form class="search" method="GET" action="/admin">
        ${statusHidden}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by IRIS-####, order id or owner email" value="${searchValue ?? ""}" />
      </form>
    </div>
    <div class="tabs">
      <a class="tab ${activeTab === "all" ? "active" : ""}" href="/admin">All</a>
      <a class="tab ${activeTab === "activated" ? "active" : ""}" href="/admin?status=activated">Activated</a>
      <a class="tab ${activeTab === "unactivated" ? "active" : ""}" href="/admin?status=unactivated">Unactivated</a>
    </div>
    <div class="card table">
      <table>
        <thead>
          <tr>
            <th>IRIS ID</th>
            <th>Status</th>
            <th>Customer Email</th>
            <th>Order Number</th>
            <th>Order Date</th>
            <th>PIN</th>
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
  const prevHref = hasPrev ? `/admin/all?${prevParams}` : "#";
  const nextHref = hasNext ? `/admin/all?${nextParams}` : "#";

  const body = `
    <div class="title-row">
      <h1>All IRISes</h1>
      <form class="search" method="GET" action="/admin/all">
        ${statusHidden}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.5" y2="16.5"></line></svg>
        <input type="text" name="q" placeholder="Search by IRIS-####, order id or owner email" value="${searchValue ?? ""}" />
      </form>
    </div>
    <div class="tabs">
      <a class="tab ${statusParam === "all" ? "active" : ""}" href="/admin/all">All</a>
      <a class="tab ${statusParam === "activated" ? "active" : ""}" href="/admin/all?status=activated">Activated</a>
      <a class="tab ${statusParam === "unactivated" ? "active" : ""}" href="/admin/all?status=unactivated">Unactivated</a>
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

const buildAdminDetailHtml = (item: {
  iris_id: string;
  status: string;
  rarity_code: string | null;
  assigned_order_id: string | null;
  assigned_customer_email: string | null;
  owner_email: string | null;
  activated_at: Date | null;
  created_at: Date;
  image_url: string | null;
  pin_code: string | null;
}) => {
  const displayId = item.iris_id.toUpperCase().startsWith("IRIS-")
    ? item.iris_id.replace(/^IRIS-/i, "#")
    : item.iris_id;
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
          <dt>Rarity</dt><dd>${item.rarity_code ?? "-"}</dd>
          <dt>Pin</dt><dd>${item.pin_code ?? "-"}</dd>
          <dt>Order Number</dt><dd>${item.assigned_order_id ?? "-"}</dd>
          <dt>Order Date</dt><dd>${new Date(item.created_at).toISOString().slice(0, 10)}</dd>
          <dt>Activation Date</dt><dd>${item.activated_at ? new Date(item.activated_at).toISOString().slice(0, 10) : "-"}</dd>
          <dt>Buyer</dt><dd>${item.assigned_customer_email ?? "-"}</dd>
          <dt>Owner</dt><dd>${item.owner_email ?? "-"}</dd>
        </dl>
        <div style="margin-top:16px;">
          <a class="btn primary" href="/admin">Back to the list</a>
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

  app.post("/apps/iris/reserve-random", async (req, reply) => {
    const reservation = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ iris_id: string }[]>`
        SELECT "iris_id" FROM "Artwork"
        WHERE "status" = 'available'
        ORDER BY random()
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (rows.length === 0) {
        return null;
      }

      const irisId = rows[0].iris_id;
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
      sendJson(reply, 409, { error: "no_available_artwork" });
      return;
    }

    sendJson(reply, 200, { reservationToken: reservation.token, irisId: reservation.iris_id });
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
    const reservationTokens = parseReservationTokens(order);
    if (reservationTokens.length === 0) {
      reply.code(400).send({ error: "missing_reservation_token" });
      return;
    }

    const orderId = order.id ? String(order.id) : null;
    const orderName = typeof order.name === "string" ? order.name : null;
    const orderNumber =
      typeof order.order_number === "number" || typeof order.order_number === "string"
        ? String(order.order_number)
        : null;
    const orderNumberDisplay = orderName ?? orderNumber ?? orderId;
    const customerEmail = extractCustomerEmail(order);
    const failed: Array<{ token: string; error: string }> = [];

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
        generatedPin = artwork?.pin_code ? null : pinCode;

        await tx.artwork.update({
          where: { iris_id: reservation.iris_id },
          data: {
            status: "assigned",
            assigned_order_id: orderNumberDisplay,
            assigned_customer_email: customerEmail,
            pin_code: pinCode,
            pin_last4: pinCode.slice(-4),
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
    const body = req.body as { iris_id?: string; pin?: string; email?: string };
    const irisId = body?.iris_id?.toUpperCase().trim();
    const pin = body?.pin?.trim();
    const email = body?.email?.trim().toLowerCase();

    if (!irisId || !pin || !email) {
      sendJson(reply, 400, { error: "missing_required_fields" });
      return;
    }

    const MAX_ATTEMPTS = 5;
    const LOCK_MINUTES = 60;

    try {
      const artwork = await prisma.artwork.findUnique({ where: { iris_id: irisId } });
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

      if (artwork.pin_locked_until && artwork.pin_locked_until > new Date()) {
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
              type: "activation_failed",
              actor: email,
              payload_json: {
                reason: "invalid_pin",
                attempts: nextAttempts,
                locked_until: lockUntil
              }
            }
          });
        });

        sendJson(reply, 401, { error: "invalid_pin" });
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

  app.post("/activate-verify", handleActivateVerify);
  app.post("/apps/iris/activate-verify", handleActivateVerify);

  app.get("/apps/iris/seen-archive", async (req, reply) => {
    const query = req.query as { limit?: string; cursor?: string };
    const limit = parseLimit(query.limit, 20);

    let cursorFilter = {};
    if (query.cursor) {
      try {
        const cursor = decodeCursor(query.cursor);
        const activatedAt = new Date(cursor.activatedAt);
        cursorFilter = {
          OR: [
            { activated_at: { lt: activatedAt } },
            { activated_at: activatedAt, iris_id: { lt: cursor.irisId } }
          ]
        };
      } catch {
        reply.code(400).send({ error: "invalid_cursor" });
        return;
      }
    }

    const items = await prisma.artwork.findMany({
      where: {
        status: "activated",
        activated_at: { not: null },
        ...cursorFilter
      },
      orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }],
      take: limit + 1
    });

    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore
      ? encodeCursor({
          activatedAt: slice[slice.length - 1].activated_at!.toISOString(),
          irisId: slice[slice.length - 1].iris_id
        })
      : null;

    sendJson(reply, 200, {
      items: slice.map((item) => ({
        iris_id: item.iris_id,
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        activated_at: item.activated_at
      })),
      nextCursor
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
      orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }]
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
      where: { iris_id: irisId }
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
      activated_at: item.activated_at,
      status: item.status,
      proof_url: proofPath
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

  app.get("/admin", async (req, reply) => {
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

  app.get("/admin/all", async (req, reply) => {
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

  app.get("/admin/iris/:irisId", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const params = req.params as { irisId: string };
    const irisId = sanitizeIrisId(params.irisId);
    if (!irisId) {
      reply.code(400).send("Invalid iris_id");
      return;
    }
    const item = await prisma.artwork.findUnique({
      where: { iris_id: irisId }
    });
    if (!item) {
      reply.code(404).send("Not found");
      return;
    }

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminDetailHtml({
          iris_id: item.iris_id,
          status: item.status,
          rarity_code: item.rarity_code,
          assigned_order_id: item.assigned_order_id,
          assigned_customer_email: item.assigned_customer_email,
          owner_email: item.owner_email,
          activated_at: item.activated_at,
          created_at: item.created_at,
          image_url: item.image_url,
          pin_code: item.pin_code
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

    reply.redirect(303, "/admin");
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
