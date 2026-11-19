import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db.js";
import { createRetailBatch, retailBatchCsv, retailSchemaReady, retailEligibleWhere } from "../src/retail-stock.js";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const apply = args.includes("--apply");

const run = async () => {
  const allowed = new Set(["--collection", "--quantity", "--reference", "--retailer", "--apply"]);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unexpected argument: ${args[i]}`);
    if (seen.has(args[i])) throw new Error(`Duplicate argument: ${args[i]}`);
    seen.add(args[i]);
    if (args[i] !== "--apply" && (!args[++i] || args[i].startsWith("--"))) throw new Error("Missing argument value.");
  }
  if (!["--collection", "--quantity", "--reference", "--retailer"].every((flag) => args.includes(flag))) {
    throw new Error("Required: --collection SLUG --quantity 25 --reference OKG-RETAIL-001 --retailer NAME [--apply]");
  }
  const host = new URL(process.env.DATABASE_URL || "").hostname;
  if (!host.startsWith("ep-aged-flower-ahtjeivv") || !host.endsWith(".neon.tech")) {
    throw new Error("Unexpected database. Run in the active iris-registry Render Shell only.");
  }
  if (!await retailSchemaReady(prisma)) throw new Error("Run npx prisma migrate deploy first.");
  const collection = await prisma.collection.findUnique({ where: { slug: value("--collection") } });
  if (!collection) throw new Error("Collection not found.");
  const request = { collectionId: collection.id, quantity: Number(value("--quantity")), reference: value("--reference"),
    retailer: value("--retailer"), actor: "admin:retail-batch-script" };
  const { validateRetailBatchRequest } = await import("../src/retail-stock.js");
  validateRetailBatchRequest(request);
  const existing = await prisma.retailBatch.findUnique({ where: { id: request.reference }, include: { items: true } });
  const eligible = await prisma.artwork.count({ where: retailEligibleWhere(collection) });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", database_host: host, collection: collection.name,
    reference: request.reference, quantity: request.quantity, existing_batch_size: existing?.items.length ?? 0,
    eligible_artworks: eligible, selection: "Random, without replacement, when applied", shopify_inventory_changed: false }, null, 2));
  if (!apply) { console.log("Dry run only. Add --apply to allocate this batch. Reuse the same reference on retries."); return; }
  const directory = path.resolve("retail-private");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await createRetailBatch(prisma, request, async (snapshot) => {
    const backup = path.join(directory, `${request.reference}-before-${Date.now()}.json`);
    await fs.writeFile(backup, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`Scoped pre-change backup: ${backup}`);
  });
  const works = await prisma.artwork.findMany({ where: { iris_id: { in: result.batch.items.map((item) => item.iris_id) } },
    orderBy: { iris_id: "asc" }, select: { iris_id: true, pin_code: true, activation_token: true } });
  // Never print PINs or NFC tokens to the Render console. The admin can download the CSV again.
  const output = path.join(directory, `${request.reference}-labels-${Date.now()}.csv`);
  await fs.writeFile(output, retailBatchCsv(works, "https://irisnyc.store"), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ created: result.created, batch: result.batch.id, serials: works.map((work) => work.iris_id),
    labels_file: output, admin_url: "/admin/retail", partner_url: "/partner/retail" }, null, 2));
  console.log("Excluded from online serial allocation. IMPORTANT: reconcile the Shopify online quantity separately; this command does not change it.");
};
run().catch((error) => { console.error(error instanceof Error ? error.message : "Retail allocation failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
