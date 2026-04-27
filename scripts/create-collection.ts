import { prisma } from "../src/db.js";

const args = process.argv.slice(2);

const getArg = (flag: string): string | null => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
};

const required = (flag: string): string => {
  const value = getArg(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
};

const numberArg = (flag: string, fallback?: number): number => {
  const value = getArg(flag);
  if (value == null) {
    if (fallback == null) {
      throw new Error(`Missing required argument: ${flag}`);
    }
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }
  return parsed;
};

const slug = required("--slug");
const name = required("--name");
const editionSize = numberArg("--edition-size");
const artworksCount = numberArg("--artworks-count", 1);
const prefix = required("--prefix").toUpperCase();
const artistName = getArg("--artist-name");
const status = (getArg("--status") ?? "draft").toLowerCase();
const shopifyProductId = getArg("--shopify-product-id");
const shopifyHandle = getArg("--shopify-handle");
const defaultPriceCents = getArg("--default-price-cents");
const startIndex = numberArg("--start-index", 1);

const validStatuses = new Set(["draft", "active", "sold_out", "archived"]);
if (!validStatuses.has(status)) {
  throw new Error(`Invalid status: ${status}`);
}

const zeroPad = Math.max(4, String(startIndex + editionSize - 1).length);

const run = async () => {
  const collection = await prisma.collection.upsert({
    where: { slug },
    update: {
      name,
      artist_name: artistName,
      edition_size: editionSize,
      artworks_count: artworksCount,
      status: status as "draft" | "active" | "sold_out" | "archived",
      shopify_product_id: shopifyProductId,
      shopify_handle: shopifyHandle,
      default_price_cents: defaultPriceCents ? Number(defaultPriceCents) : null
    },
    create: {
      slug,
      name,
      artist_name: artistName,
      edition_size: editionSize,
      artworks_count: artworksCount,
      status: status as "draft" | "active" | "sold_out" | "archived",
      shopify_product_id: shopifyProductId,
      shopify_handle: shopifyHandle,
      default_price_cents: defaultPriceCents ? Number(defaultPriceCents) : null
    }
  });

  const data = Array.from({ length: editionSize }, (_, index) => ({
    iris_id: `${prefix}-${String(startIndex + index).padStart(zeroPad, "0")}`,
    status: "available" as const,
    collection_id: collection.id
  }));

  await prisma.artwork.createMany({
    data,
    skipDuplicates: true
  });

  await prisma.artwork.updateMany({
    where: {
      iris_id: { in: data.map((item) => item.iris_id) },
      collection_id: null
    },
    data: { collection_id: collection.id }
  });

  console.log(
    `Collection ${collection.name} (${collection.slug}) ready. Linked ${editionSize} artworks with prefix ${prefix}.`
  );
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
