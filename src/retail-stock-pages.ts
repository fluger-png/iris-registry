import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadRetailStock, markRetailSold, retailBatchCsv, retailCsrf, retailSchemaReady, RetailStockError,
  RetailStockView, validRetailCsrf, numberRetailBatches, formatRetailBatchDate } from "./retail-stock.js";

type Escape = (value: string) => string;
export const buildRetailStockBody = (batches: RetailStockView, partner: boolean, secret: string, h: Escape) => {
  const base = partner ? "/partner/retail" : "/admin/retail";
  const entries = batches.flatMap((batch) => batch.items);
  return `<style>
    .main{min-width:0;}
    .retail-section{margin-top:32px;min-width:0;}
    .retail-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px;}
    .retail-heading h2{margin:0;font-size:20px;}
    .retail-heading > div{min-width:0;max-width:100%;overflow-wrap:anywhere;}
    .retail-heading > .btn{width:auto;height:auto;min-height:34px;padding:8px 12px;white-space:nowrap;line-height:1.4;}
    .retail-table{overflow-x:auto;max-width:100%;}
    .retail-table table{width:100%;min-width:650px;border-collapse:collapse;}
    .retail-table th,.retail-table td{text-align:left;padding:12px;border-bottom:1px solid var(--line);}
    .retail-table th{font-size:12px;}
    .retail-table img{width:50px;height:50px;object-fit:cover;display:block;}
    .retail-table form{margin:0;}
    .retail-summary{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0;}
    .retail-summary div{display:flex;flex-direction:column;gap:8px;}
    .retail-summary strong{font-family:var(--font-heading,inherit);font-size:24px;font-weight:500;color:var(--gold-bright,var(--ink));}
    .retail-summary span{font-size:12px;}
    .retail-table .btn{white-space:nowrap;width:auto;height:auto;min-height:32px;padding:8px 12px;}
  </style>
  <div class="title-row section-heading">${partner ? "<h2>Retail Stock</h2>" : "<h1>Retail Stock</h1>"}</div>
  <div class="retail-summary">
    <div><span>Allocated</span><strong>${entries.length}</strong></div>
    <div><span>In store</span><strong>${entries.filter((item) => !item.sold_at).length}</strong></div>
    <div><span>Sold</span><strong>${entries.filter((item) => item.sold_at).length}</strong></div>
    <div><span>Activated</span><strong>${entries.filter((item) => item.artwork.status === "activated").length}</strong></div>
  </div>
  ${numberRetailBatches(batches).map((batch) => `<section class="retail-section">
    <div class="retail-heading"><div><h2>${h(batch.collection.name)} &middot; Batch ${batch.batch_number}</h2><p>${h(formatRetailBatchDate(batch.created_at))} &middot; ${batch.items.length} IRIS<br />${h(batch.id)} &middot; ${h(batch.retailer)}</p></div>
      ${partner ? "" : `<a class="btn secondary" href="${base}/${encodeURIComponent(batch.id)}/labels.csv">Download PIN / NFC CSV</a>`}</div>
    <div class="retail-table"><table><thead><tr><th>Image</th><th>IRIS</th><th>Status</th><th>Sold</th><th>Owner</th><th>Action</th></tr></thead><tbody>
    ${batch.items.map((item) => {
      const work = item.artwork;
      const state = work.status === "activated" ? "Activated" : item.sold_at ? "Sold / awaiting activation" : "In store";
      return `<tr><td>${work.image_url ? `<img src="${h(work.image_url)}" alt="" width="50" height="50" loading="lazy" />` : "-"}</td>
        <td>${partner ? h(item.iris_id) : `<a class="iris-link" href="/admin/iris/${encodeURIComponent(item.iris_id)}">${h(item.iris_id)}</a>`}</td>
        <td>${state}</td><td>${item.sold_at ? h(item.sold_at.toLocaleDateString("en-US", { timeZone: "America/New_York" })) : "-"}</td>
        <td>${h(work.owner_email ?? "-")}</td><td>${!item.sold_at && work.status === "retail_stock" ? `<form method="POST" action="${base}/${encodeURIComponent(item.iris_id)}/sold" data-retail-sale>
          <input type="hidden" name="csrf_token" value="${retailCsrf(secret, item.iris_id)}" />
          <button class="btn${partner ? "" : " primary"}" type="submit">Mark sold</button></form>` : "-"}</td></tr>`;
    }).join("")}</tbody></table></div></section>`).join("") || '<p class="muted">No retail batches.</p>'}
  <script>document.querySelectorAll('[data-retail-sale]').forEach(function(form){form.addEventListener('submit',function(event){if(!confirm('Confirm this IRIS was sold to a customer? This enables activation.'))event.preventDefault();});});</script>`;
};

type Context = { collectionIds?: string[]; actor: string; secret: string; render: (body: string) => string };
export const registerRetailStockPages = (app: FastifyInstance, options: {
  db: PrismaClient; origin: string; escape: Escape;
  adminContext: (req: any, reply: any) => Promise<Context | null>;
  partnerContext: (req: any, reply: any) => Promise<Context | null>;
}) => {
  const { db, origin, escape: h } = options;
  for (const partner of [false, true]) {
    const base = partner ? "/partner/retail" : "/admin/retail";
    const context = partner ? options.partnerContext : options.adminContext;
    app.get(base, async (req, reply) => {
      const auth = await context(req, reply);
      if (!auth) return;
      reply.header("Cache-Control", "private, no-store");
      if (!await retailSchemaReady(db)) return reply.code(503).type("text/html; charset=utf-8")
        .send(auth.render('<h1>Retail Stock</h1><p>Retail stock is unavailable until the database migration is applied.</p>'));
      const batches = await loadRetailStock(db, auth.collectionIds);
      return reply.type("text/html; charset=utf-8").send(auth.render(buildRetailStockBody(batches, partner, auth.secret, h)));
    });
    app.post(`${base}/:irisId/sold`, { bodyLimit: 2048 }, async (req, reply) => {
      const auth = await context(req, reply);
      if (!auth) return;
      reply.header("Cache-Control", "private, no-store");
      const { irisId } = req.params as { irisId: string };
      const body = req.body as Record<string, unknown> | null;
      if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded" ||
          !body || Object.keys(body).join() !== "csrf_token" || !validRetailCsrf(body.csrf_token, auth.secret, irisId)) {
        return reply.code(403).send("Invalid form. Reload before trying again.");
      }
      try {
        const ids = auth.collectionIds ?? (await db.collection.findMany({ select: { id: true } })).map((c) => c.id);
        await markRetailSold(db, irisId, ids, auth.actor);
        return reply.redirect(303, base);
      } catch (error) {
        if (error instanceof RetailStockError) return reply.code(error.status).send(error.message);
        req.log.error({ irisId }, "Retail sale could not be recorded");
        return reply.code(503).send("Sale not confirmed. Reload to check the current status.");
      }
    });
  }
  app.get("/admin/retail/:batchId/labels.csv", async (req, reply) => {
    const auth = await options.adminContext(req, reply);
    if (!auth) return;
    reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    const { batchId } = req.params as { batchId: string };
    if (!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(batchId)) return reply.code(400).send("Invalid batch.");
    const batch = await db.retailBatch.findUnique({ where: { id: batchId }, include: { items: {
      orderBy: { iris_id: "asc" }, include: { artwork: { select: { iris_id: true, pin_code: true, activation_token: true } } }
    } } });
    if (!batch) return reply.code(404).send("Batch not found.");
    const csv = retailBatchCsv(batch.items.map((item) => item.artwork), origin);
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${batchId}-labels.csv"`).send(csv);
  });
};
