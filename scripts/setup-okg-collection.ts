import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db.js";
import { OKG_COLLECTION, okgArtworkIds } from "../src/collection-release.js";

const apply = process.argv.includes("--apply");
const sendInvite = process.argv.includes("--send-invite");
const email = "fluger@fluger.com";

const run = async () => {
  const databaseHost = new URL(process.env.DATABASE_URL || "").hostname;
  if (!databaseHost.startsWith("ep-aged-flower-ahtjeivv") || !databaseHost.endsWith(".neon.tech")) {
    throw new Error("Unexpected database host. Run this only in the active iris-registry Render Shell after checking the production backup.");
  }
  const productResponse = await fetch(`https://irisnyc.store/products/${OKG_COLLECTION.slug}.js`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000)
  });
  if (!productResponse.ok) throw new Error("Cannot verify the Shopify product. No data changed.");
  const product = await productResponse.json() as { id?: number; price?: number };
  if (String(product.id) !== OKG_COLLECTION.productId || !Number.isSafeInteger(product.price) || Number(product.price) <= 0) {
    throw new Error("Shopify product identity or price differs from the approved setup. No data changed.");
  }
  const ids = okgArtworkIds();
  const [collection, works, partner] = await Promise.all([
    prisma.collection.findUnique({ where: { slug: OKG_COLLECTION.slug }, include: { presentation: true } }),
    prisma.artwork.findMany({ where: { iris_id: { in: ids } }, select: { iris_id: true, collection_id: true, rarity_code: true } }),
    prisma.collaboratorUser.findUnique({ where: { email }, select: {
      id: true, full_name: true, status: true, collection_id: true, invitation_sent_at: true,
      collection_access: { select: { collection_id: true } }
    } })
  ]);
  if (partner && partner.full_name !== OKG_COLLECTION.artistName) {
    throw new Error("This email already has a different partner workspace. No permissions changed.");
  }
  if (collection && (collection.edition_size !== 100 || collection.shopify_handle !== OKG_COLLECTION.slug ||
      collection.shopify_product_id !== OKG_COLLECTION.productId)) {
    throw new Error("Existing collection differs from the approved OKG setup. No data changed.");
  }
  if (works.some((work) => !collection || work.collection_id !== collection.id || work.rarity_code !== null)) {
    throw new Error("Serial collision or existing rarity detected. No artworks overwritten.");
  }
  if (partner && (!collection || partner.collection_access.some((grant) => grant.collection_id !== collection.id) ||
      (partner.collection_id && partner.collection_id !== collection.id))) {
    throw new Error("The existing partner has other collection grants. Review access manually.");
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", collection: OKG_COLLECTION.name,
    database_host: databaseHost,
    serials: [ids[0], ids.at(-1)], existing_artworks: works.length, new_artworks: 100 - works.length,
    rarity: null, visible: false, partner_email: email, send_invite: sendInvite }, null, 2));
  if (!apply) return;

  const backupPath = path.resolve(`okg-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(backupPath, JSON.stringify({ collection, works, partner }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(`Scoped pre-change backup: ${backupPath}`);

  const ready = await prisma.$transaction(async (tx) => {
    // Create only missing records; never reset ownership or an existing partner's access.
    const record = await tx.collection.upsert({ where: { slug: OKG_COLLECTION.slug }, update: {}, create: {
      slug: OKG_COLLECTION.slug, name: OKG_COLLECTION.name, artist_name: OKG_COLLECTION.artistName,
      edition_size: 100, artworks_count: 100, status: "active", shopify_product_id: OKG_COLLECTION.productId,
      shopify_handle: OKG_COLLECTION.slug, default_price_cents: product.price,
      presentation: { create: { visible: false } }
    } });
    if (!collection?.presentation) {
      await tx.collectionPresentation.upsert({ where: { collection_id: record.id }, update: {},
        create: { collection_id: record.id, visible: false } });
    }
    await tx.artwork.createMany({ data: ids.map((iris_id) => ({ iris_id, collection_id: record.id,
      status: "available" as const, rarity_code: null })), skipDuplicates: true });
    const count = await tx.artwork.count({ where: { collection_id: record.id } });
    if (count !== 100) throw new Error(`Unexpected collection size: ${count}. Transaction rolled back.`);
    return record;
  });

  if (!sendInvite) {
    console.log("Collection ready. Add --send-invite to create the partner workspace.");
    return;
  }
  if (partner) {
    console.log("OKG partner already exists. No invitation reissued or sessions revoked.");
    return;
  }
  const { env } = await import("../src/env.js");
  const { createServer } = await import("../src/server.js");
  const app = await createServer();
  try {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: {
      authorization: `Basic ${Buffer.from(`${env.adminBasicUser}:${env.adminBasicPass}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    }, payload: new URLSearchParams({ full_name: OKG_COLLECTION.artistName, email, collection_ids: ready.id }).toString() });
    if (response.statusCode !== 200) throw new Error(`Partner setup failed (HTTP ${response.statusCode}). Collection preserved.`);
    console.log(response.body.includes("Invitation sent successfully.")
      ? "OKG partner created; invitation sent to fluger@fluger.com."
      : "OKG partner created, but email delivery unconfirmed. Use Resend in Collaborators.");
  } finally { await app.close(); }
};

run().catch((error) => { console.error(error instanceof Error ? error.message : "OKG setup failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
