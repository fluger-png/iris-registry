import { FastifyInstance } from "fastify";
import { Prisma, PrismaClient } from "@prisma/client";
import { loadPartnerCollection, PartnerCollectionView } from "./partner-collections.js";
import { adminCollectionsCsrf, validAdminCollectionsCsrf, loadStorefrontOrder, sortStorefrontCollections, isCompleteCollectionOrder } from "./storefront-collections.js";

type OrderState = Awaited<ReturnType<typeof loadStorefrontOrder>>;
type HtmlEscape = (value: string) => string;
class CollectionConflict extends Error {}

export const buildAdminCollectionsBody = (views: PartnerCollectionView[], order: OrderState, csrf: string, h: HtmlEscape) => {
  const number = (value: number) => new Intl.NumberFormat("en-US").format(value);
  const rows = views.map((view) => {
    const c = view.collection;
    const p = view.presentation.record;
    const image = p?.banner_url ?? view.product?.imageUrl;
    const cents = view.product?.priceCents ?? c.default_price_cents;
    const price = cents === null || cents === undefined ? "-" : new Intl.NumberFormat("en-US", {
      style: "currency", currency: view.product?.currency ?? "USD", minimumFractionDigits: 0, maximumFractionDigits: 2
    }).format(cents / 100);
    return `<tr data-collection-id="${h(c.id)}">
      <td><div class="collection-order-tools">
        <button type="button" class="collection-icon collection-grip" data-drag title="Drag to reorder" aria-label="Reorder ${h(p?.display_name ?? c.name)}"${order.available ? "" : " disabled"}>&#x283F;</button>
        <button type="button" class="collection-icon" data-up title="Move up" aria-label="Move ${h(c.name)} up">&#8593;</button>
        <button type="button" class="collection-icon" data-down title="Move down" aria-label="Move ${h(c.name)} down">&#8595;</button>
      </div></td>
      <td><div class="collection-admin-identity">${image ? `<img src="${h(image)}" alt="" width="96" height="54" />` : `<span class="collection-admin-placeholder" aria-hidden="true"></span>`}
        <div><strong>${h(p?.display_name ?? c.name)}</strong><span class="muted">${h(c.artist_name ?? "")}</span></div>
      </div></td>
      <td>${number(c.edition_size)}</td><td>${number(view.purchased)}</td><td>${number(view.activated)}</td><td class="collection-admin-price">${h(price)}</td>
      <td><label class="collection-switch"><input type="checkbox" role="switch" data-visibility data-revision="${p?.revision ?? -1}" aria-label="Show ${h(c.name)} on storefront"${p?.visible === false ? "" : " checked"}${view.presentation.available ? "" : " disabled"} /><span></span></label></td>
    </tr>`;
  }).join("");
  const config = JSON.stringify({ csrf, revision: order.revision, available: order.available }).replace(/</g, "\\u003c");
  return `<style>
    .main{min-width:0;}
    .collection-admin-table{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card);}
    .collection-admin-table table{min-width:820px;}
    .collection-admin-table th{white-space:nowrap;}
    .collection-admin-identity{display:flex;align-items:center;gap:14px;min-width:220px;}
    .collection-admin-identity img,.collection-admin-placeholder{width:96px;height:54px;object-fit:cover;background:var(--bg);flex:none;}
    .collection-admin-identity strong{display:block;font-size:14px;}
    .collection-admin-identity .muted{display:block;margin-top:5px;}
    .collection-admin-price{white-space:nowrap;font-weight:700;}
    .collection-order-tools{display:flex;align-items:center;gap:3px;}
    .collection-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:34px;padding:0;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--muted);font:inherit;font-size:18px;cursor:pointer;flex:none;}
    .collection-icon:hover:not(:disabled){color:var(--brand);border-color:var(--brand);}
    .collection-icon:disabled{opacity:.3;cursor:default;}
    .collection-grip{touch-action:none;cursor:grab;font-size:24px;}
    .collection-admin-table tr.is-dragging{background:var(--pill);}
    .collection-admin-table button:focus-visible,.collection-switch input:focus-visible + span{outline:2px solid var(--brand);outline-offset:3px;}
    .collection-switch{position:relative;display:block;width:42px;height:24px;cursor:pointer;}
    .collection-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;}
    .collection-switch span{display:block;width:42px;height:24px;border-radius:12px;background:#CBD0DD;pointer-events:none;}
    .collection-switch span:after{content:"";display:block;position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;}
    .collection-switch input:checked + span{background:var(--brand);}
    .collection-switch input:checked + span:after{transform:translateX(18px);}
    .collection-switch input:disabled + span{opacity:.4;}
    .collection-admin-status{min-height:20px;margin:0 0 12px;color:var(--muted);}
    .collection-admin-status[data-error="true"]{color:#B42318;}
    @media(prefers-reduced-motion:reduce){.collection-switch span:after{transition:none;}}
  </style>
  <div class="title-row"><h1>Collections</h1></div>
  <div class="admin-stat-grid">
    <div class="admin-stat"><span>Collections</span><strong>${number(views.length)}</strong></div>
    <div class="admin-stat"><span>Edition Size</span><strong>${number(views.reduce((sum, v) => sum + v.collection.edition_size, 0))}</strong></div>
    <div class="admin-stat"><span>Sold</span><strong>${number(views.reduce((sum, v) => sum + v.purchased, 0))}</strong></div>
    <div class="admin-stat"><span>Activated</span><strong>${number(views.reduce((sum, v) => sum + v.activated, 0))}</strong></div>
  </div>
  <p class="collection-admin-status" role="status" aria-live="polite" data-collections-status${order.available ? "" : ' data-error="true"'}>${order.available ? "" : "Ordering is unavailable until the database migration is applied."}</p>
  <div class="collection-admin-table"><table><thead><tr><th>Order</th><th>Collection</th><th>Edition Size</th><th>Sold</th><th>Activated</th><th>Price</th><th>Storefront</th></tr></thead>
  <tbody data-collection-rows>${rows}</tbody></table></div>
  ${views.length ? "" : '<p class="muted">No collections found.</p>'}
  <script>
  (function(){
    var config=${config};
    var list=document.querySelector('[data-collection-rows]');
    var status=document.querySelector('[data-collections-status]');
    if(!list||!status)return;
    var busy=false,drag=null;
    function rows(){return Array.from(list.querySelectorAll('[data-collection-id]'));}
    function ids(){return rows().map(function(row){return row.dataset.collectionId;});}
    function message(text,error){status.textContent=text;status.dataset.error=error?'true':'false';}
    function controls(){var all=rows();all.forEach(function(row,i){
      row.querySelector('[data-up]').disabled=busy||!config.available||i===0;
      row.querySelector('[data-down]').disabled=busy||!config.available||i===all.length-1;
      row.querySelector('[data-drag]').disabled=busy||!config.available;
    });list.querySelectorAll('[data-visibility]').forEach(function(input){input.disabled=busy||input.dataset.unavailable==='true';});}
    list.querySelectorAll('[data-visibility]').forEach(function(input){if(input.disabled)input.dataset.unavailable='true';});
    function restore(order){order.forEach(function(id){var row=rows().find(function(item){return item.dataset.collectionId===id;});if(row)list.appendChild(row);});}
    async function post(url,data){
      var response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(Object.assign({csrf_token:config.csrf},data))});
      var result=await response.json().catch(function(){return null;});
      if(!response.ok)throw new Error(result&&result.message||'Could not save. Reload to check the current settings.');
      return result;
    }
    async function saveOrder(previous){
      if(previous.join('|')===ids().join('|'))return;
      busy=true;controls();message('Saving order...');
      try{var result=await post('/admin/collections/order',{ids:ids(),revision:config.revision});config.revision=result.revision;message('Order saved.');}
      catch(error){restore(previous);message(error.message,true);}
      finally{busy=false;controls();}
    }
    list.addEventListener('click',function(event){
      var button=event.target.closest('[data-up],[data-down]');if(!button||button.disabled||busy)return;
      var row=button.closest('[data-collection-id]'),previous=ids();
      if(button.hasAttribute('data-up')&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);
      else if(button.hasAttribute('data-down')&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);
      saveOrder(previous);
    });
    list.addEventListener('change',async function(event){
      var input=event.target;if(!input.matches('[data-visibility]')||busy)return;
      var row=input.closest('[data-collection-id]'),wanted=input.checked;
      busy=true;controls();message('Saving visibility...');
      try{var result=await post('/admin/collections/'+encodeURIComponent(row.dataset.collectionId)+'/visibility',{visible:wanted,revision:Number(input.dataset.revision)});input.dataset.revision=String(result.revision);message('Visibility saved.');}
      catch(error){input.checked=!wanted;message(error.message,true);}
      finally{busy=false;controls();}
    });
    list.addEventListener('pointerdown',function(event){
      var grip=event.target.closest('[data-drag]');if(!grip||grip.disabled||busy||event.button!==0)return;
      var row=grip.closest('[data-collection-id]');drag={row:row,previous:ids(),grip:grip,pointerId:event.pointerId};
      grip.setPointerCapture(event.pointerId);row.classList.add('is-dragging');event.preventDefault();
    });
    list.addEventListener('pointermove',function(event){
      if(!drag||event.pointerId!==drag.pointerId)return;
      var target=document.elementFromPoint(event.clientX,event.clientY);
      var row=target&&target.closest('[data-collection-id]');
      if(row&&row!==drag.row&&row.parentElement===list){var box=row.getBoundingClientRect();list.insertBefore(drag.row,event.clientY<box.top+box.height/2?row:row.nextSibling);}
      if(event.clientY<60)window.scrollBy(0,-12);else if(event.clientY>window.innerHeight-60)window.scrollBy(0,12);
    });
    function endDrag(event){
      if(!drag||event.pointerId!==drag.pointerId)return;
      var state=drag;drag=null;state.row.classList.remove('is-dragging');
      if(state.grip.hasPointerCapture(event.pointerId))state.grip.releasePointerCapture(event.pointerId);
      if(event.type==='pointercancel'){restore(state.previous);controls();}else saveOrder(state.previous);
    }
    list.addEventListener('pointerup',endDrag);list.addEventListener('pointercancel',endDrag);
    controls();
  })();
  </script>`;
};

export const registerAdminCollections = (app: FastifyInstance, options: {
  db: PrismaClient; secret: string; authorize: (req: any, reply: any) => Promise<boolean>;
  shell: (title: string, body: string, search: string, tab: string) => string; escape: HtmlEscape;
}) => {
  const { db, secret, authorize, shell, escape } = options;
  app.get("/admin/collections", async (req, reply) => {
    if (!(await authorize(req, reply))) return;
    const [collections, order] = await Promise.all([db.collection.findMany(), loadStorefrontOrder(db)]);
    const views = await Promise.all(sortStorefrontCollections(collections, order.ids).map((c) => loadPartnerCollection(db, c)));
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(shell("Collections - IRIS Admin",
      buildAdminCollectionsBody(views, order, adminCollectionsCsrf(secret, Date.now()), escape), "", "collections"));
  });

  const failWrite = (error: unknown, reply: any) => {
    if (error instanceof CollectionConflict || error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      return reply.code(409).send({ message: "These settings changed in another window. Reload before saving again." });
    }
    return reply.code(503).send({ message: "Could not save. Reload to check the current settings before trying again." });
  };
  app.post("/admin/collections/order", { bodyLimit: 32_768 }, async (req, reply) => {
    if (!(await authorize(req, reply))) return;
    const body = req.body as Record<string, unknown> | null;
    if (!body || !validAdminCollectionsCsrf(body.csrf_token, secret)) return reply.code(403).send({ message: "Your form expired. Reload this page." });
    if (Object.keys(body).sort().join() !== "csrf_token,ids,revision" || !Number.isSafeInteger(body.revision) || Number(body.revision) < -1) return reply.code(400).send({ message: "Invalid collection order." });
    try {
      const revision = await db.$transaction(async (tx) => {
        const collections = await tx.collection.findMany({ select: { id: true } });
        if (!isCompleteCollectionOrder(body.ids, collections.map((c) => c.id))) throw new CollectionConflict();
        const current = await tx.collectionStorefrontOrder.findUnique({ where: { id: "global" } });
        if ((current?.revision ?? -1) !== body.revision) throw new CollectionConflict();
        if (!current) await tx.collectionStorefrontOrder.create({ data: { id: "global", collection_ids: body.ids } });
        else {
          const result = await tx.collectionStorefrontOrder.updateMany({ where: { id: "global", revision: current.revision }, data: { collection_ids: body.ids, revision: { increment: 1 } } });
          if (result.count !== 1) throw new CollectionConflict();
        }
        return Number(body.revision) + 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      req.log.info({ collectionIds: body.ids, revision }, "Admin collection order saved");
      return reply.header("Cache-Control", "no-store").send({ revision });
    } catch (error) { req.log.warn({ err: error }, "Admin collection order not saved"); return failWrite(error, reply); }
  });

  app.post("/admin/collections/:id/visibility", { bodyLimit: 2048 }, async (req, reply) => {
    if (!(await authorize(req, reply))) return;
    const body = req.body as Record<string, unknown> | null;
    const { id } = req.params as { id: string };
    if (!body || !validAdminCollectionsCsrf(body.csrf_token, secret)) return reply.code(403).send({ message: "Your form expired. Reload this page." });
    if (Object.keys(body).sort().join() !== "csrf_token,revision,visible" || typeof body.visible !== "boolean" || !Number.isSafeInteger(body.revision) || Number(body.revision) < -1) return reply.code(400).send({ message: "Invalid collection visibility." });
    if (!await db.collection.findFirst({ where: { id }, select: { id: true } })) return reply.code(404).send({ message: "Collection not found." });
    try {
      const revision = await db.$transaction(async (tx) => {
        const current = await tx.collectionPresentation.findUnique({ where: { collection_id: id } });
        if ((current?.revision ?? -1) !== body.revision) throw new CollectionConflict();
        if (!current) await tx.collectionPresentation.create({ data: { collection_id: id, visible: body.visible as boolean } });
        else {
          const result = await tx.collectionPresentation.updateMany({ where: { collection_id: id, revision: current.revision }, data: { visible: body.visible as boolean, revision: { increment: 1 } } });
          if (result.count !== 1) throw new CollectionConflict();
        }
        return Number(body.revision) + 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      req.log.info({ collectionId: id, visible: body.visible, revision }, "Admin collection visibility saved");
      return reply.header("Cache-Control", "no-store").send({ revision });
    } catch (error) { req.log.warn({ err: error }, "Admin collection visibility not saved"); return failWrite(error, reply); }
  });
};
