import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Collection, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { collectionArtworkId } from "./collaborator-access.js";
import { loadPartnerCollection, PartnerCollectionView } from "./partner-collections.js";
import { adminCollectionsCsrf, validAdminCollectionsCsrf } from "./storefront-collections.js";
import { createRetailBatch, MAX_RETAIL_BATCH_SIZE, retailEligibleWhere, retailSchemaReady, RetailStockError } from "./retail-stock.js";

type Escape = (value: string) => string;
type DetailState = { view: PartnerCollectionView; available: number; retailStock: number; ready: boolean };
const newBatchReference = () => `RETAIL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

export const buildAdminCollectionDetailBody = (state: DetailState, form: {
  csrf: string; reference: string; error?: string; batch?: { id: string; quantity: number };
}, h: Escape) => {
  const { view, available, retailStock, ready } = state;
  const c = view.collection;
  const title = view.presentation.record?.display_name || c.name;
  const image = view.presentation.record?.banner_url || view.product?.imageUrl;
  const cents = view.product?.priceCents ?? c.default_price_cents;
  const price = cents == null ? "-" : new Intl.NumberFormat("en-US", { style: "currency", currency: view.product?.currency ?? "USD", maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(cents / 100);
  const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
  const max = Math.min(available, MAX_RETAIL_BATCH_SIZE);
  const stats = [["Edition Size", number(c.edition_size)], ["Available", number(available)], ["Retail Stock", number(retailStock)],
    ["Sold", number(view.purchased)], ["Activated", number(view.activated)], ["Price", price], ["Avg. Gold Sold", view.averageWeight == null ? "-" : `${view.averageWeight.toFixed(3)} g`]];
  return `<style>
    .collection-detail-header{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:20px;}
    .collection-detail-title{display:flex;gap:16px;align-items:center;min-width:0;max-width:100%;}
    .collection-detail-title img{width:144px;height:81px;object-fit:cover;flex:none;}
    .collection-detail-title h1{font-size:20px;margin:0;overflow-wrap:anywhere;}
    .collection-detail-title p{margin:8px 0 0;color:var(--muted);}
    .collection-detail-title > div{min-width:0;}
    .collection-retail-request{padding:20px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:24px 0 32px;}
    .collection-retail-request h2{font-size:16px;margin:0 0 16px;}
    .collection-retail-request form{display:flex;align-items:end;gap:16px;flex-wrap:wrap;}
    .collection-retail-request label{display:grid;gap:6px;font-size:12px;}
    .collection-retail-request input[type=number]{width:96px;height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:4px;font:inherit;background:#fff;color:var(--ink);}
    .collection-retail-request .btn{width:auto;min-width:160px;height:36px;padding:6px 14px;border-radius:4px;}
    .collection-retail-request .btn:disabled{opacity:.45;cursor:not-allowed;}
    .collection-retail-availability{margin:12px 0 0;color:var(--muted);}
    .collection-detail-notice{padding:14px 16px;margin:18px 0;border:1px solid var(--line);border-radius:4px;background:#fff;line-height:1.7;overflow-wrap:anywhere;}
    .collection-detail-notice a,.collection-detail-header > a{color:var(--brand);text-decoration:underline;}
    .collection-detail-error{border-color:#B42318;color:#B42318;}
    @media(max-width:520px){.collection-detail-title{align-items:start;}.collection-detail-title img{width:96px;height:54px;}.collection-detail-title h1{font-size:18px;}}
  </style>
  <header class="collection-detail-header"><div class="collection-detail-title">
    ${image ? `<img src="${h(image)}" alt="" width="144" height="81" />` : ""}
    <div><h1>${h(title)}</h1><p>${h(c.artist_name || "")}</p></div></div><a href="/admin/collections">Back to Collections</a></header>
  <div class="admin-stat-grid">${stats.map(([label, value]) => `<div class="admin-stat"><span>${label}</span><strong>${h(value)}</strong></div>`).join("")}</div>
  ${form.error ? `<div class="collection-detail-notice collection-detail-error" role="alert">${h(form.error)}</div>` : ""}
  ${form.batch ? `<div class="collection-detail-notice" role="status"><strong>${h(form.batch.id)}</strong>: ${form.batch.quantity} IRIS allocated.
    <a href="/admin/retail">View Retail Stock</a> &middot; <a href="/admin/retail/${encodeURIComponent(form.batch.id)}/labels.csv">Download PIN / NFC CSV</a><br />Shopify inventory was not updated by this allocation.</div>` : ""}
  <section class="collection-retail-request"><h2>Retail Stock</h2>
    <form method="POST" action="/admin/collections/${encodeURIComponent(c.id)}/retail" data-retail-request>
      <input type="hidden" name="csrf_token" value="${h(form.csrf)}" /><input type="hidden" name="reference" value="${h(form.reference)}" />
      <label>Quantity<input type="number" name="quantity" min="1" max="${Math.max(0, max)}" step="1" value="${max ? Math.min(25, max) : ""}" required${ready && max > 0 ? "" : " disabled"} /></label>
      <button class="btn primary" type="submit"${ready && max > 0 ? "" : " disabled"}>Request Retail Stock</button>
    </form>
    <p class="collection-retail-availability">Available: <strong>${number(available)}</strong>${available > MAX_RETAIL_BATCH_SIZE ? ` &middot; Batch limit: ${number(MAX_RETAIL_BATCH_SIZE)}` : ""}${ready ? "" : " &middot; Database migration required"}</p>
  </section>
  <script>(function(){var form=document.querySelector('[data-retail-request]');if(!form)return;form.addEventListener('submit',function(event){
    if(!form.reportValidity()||!confirm('Allocate '+form.elements.quantity.value+' random IRIS for retail? These serials will be removed from the online pool. Shopify inventory must be adjusted separately.')){event.preventDefault();return;}
    var button=form.querySelector('button');button.disabled=true;button.textContent='Allocating...';form.setAttribute('aria-busy','true');
  });})();</script>`;
};

export const registerAdminCollectionDetail = (app: FastifyInstance, options: {
  db: PrismaClient; secret: string; authorize: (req: any, reply: any) => Promise<boolean>; escape: Escape;
  renderArchive: (req: any, reply: any, collection: Collection, prefix: string) => Promise<unknown>;
}) => {
  const { db, secret, authorize, escape: h, renderArchive } = options;
  const render = async (req: any, reply: any, collection: Collection, reference: string, error?: string) => {
    const ready = await retailSchemaReady(db);
    const where = retailEligibleWhere(collection);
    const [view, available, retailStock] = await Promise.all([
      loadPartnerCollection(db, collection),
      db.artwork.count({ where: ready ? where : { ...where, retail_entry: undefined } }),
      ready ? db.artwork.count({ where: { collection_id: collectionArtworkId(collection), status: "retail_stock" } }) : Promise.resolve(0)
    ]);
    let batch: { id: string; quantity: number } | undefined;
    const requestedBatch = req.query?.retail_batch;
    if (typeof requestedBatch === "string" && /^[A-Z0-9][A-Z0-9-]{2,63}$/.test(requestedBatch) && ready) {
      const record = await db.retailBatch.findUnique({ where: { id: requestedBatch }, include: { _count: { select: { items: true } } } });
      if (record?.collection_id === collection.id) batch = { id: record.id, quantity: record._count.items };
    }
    return renderArchive(req, reply, collection, buildAdminCollectionDetailBody({ view, available, retailStock, ready }, {
      csrf: adminCollectionsCsrf(secret, Date.now()), reference, error, batch
    }, h));
  };
  app.get("/admin/collections/:id", async (req, reply) => {
    if (!await authorize(req, reply)) return;
    reply.header("Cache-Control", "private, no-store");
    const { id } = req.params as { id: string };
    const collection = await db.collection.findUnique({ where: { id } });
    if (!collection) return reply.code(404).send("Collection not found.");
    return render(req, reply, collection, newBatchReference());
  });
  app.post("/admin/collections/:id/retail", { bodyLimit: 2048 }, async (req, reply) => {
    if (!await authorize(req, reply)) return;
    reply.header("Cache-Control", "private, no-store");
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | null;
    if (!body || !validAdminCollectionsCsrf(body.csrf_token, secret)) return reply.code(403).send("Your form expired. Reload this page.");
    if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded" ||
        Object.keys(body).sort().join() !== "csrf_token,quantity,reference" || typeof body.reference !== "string" ||
        !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(body.reference) || typeof body.quantity !== "string" || !/^\d+$/.test(body.quantity)) {
      return reply.code(400).send("Invalid retail stock request.");
    }
    const collection = await db.collection.findUnique({ where: { id } });
    if (!collection) return reply.code(404).send("Collection not found.");
    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_RETAIL_BATCH_SIZE) {
      reply.code(400);
      return render(req, reply, collection, body.reference, `Enter a quantity from 1 to ${MAX_RETAIL_BATCH_SIZE}.`);
    }
    try {
      const result = await createRetailBatch(db, { reference: body.reference, collectionId: id, quantity,
        retailer: collection.artist_name || collection.name, actor: "admin:collection-retail" }, async (snapshot) => {
        const directory = path.resolve("retail-private");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, `${body.reference}-before-${crypto.randomUUID()}.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
      });
      return reply.redirect(303, `/admin/collections/${encodeURIComponent(id)}?retail_batch=${encodeURIComponent(result.batch.id)}`);
    } catch (error) {
      req.log.warn({ collectionId: id, reference: body.reference }, "Retail batch request failed or unconfirmed");
      reply.code(error instanceof RetailStockError ? error.status : 503);
      return render(req, reply, collection, body.reference, error instanceof RetailStockError ? error.message : "Allocation could not be confirmed. Check Retail Stock before submitting a new request.");
    }
  });
};
