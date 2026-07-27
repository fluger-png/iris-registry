import crypto from "node:crypto";

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
  if (!value?.trim()) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value.trim();
};

const normalizeCollectionSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const CORE_COLLECTION_SLUG = "iris-the-unseen-edition";
const CORE_COLLECTION_ALIASES = new Set([
  CORE_COLLECTION_SLUG,
  "iris-collection",
  "iris"
]);

const generateActivationToken = (): string => crypto.randomBytes(16).toString("hex");
const generatePin = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const orderNumber = required("--order-number");
const customerEmail = getArg("--email")?.trim().toLowerCase() || null;
const orderId = getArg("--order-id")?.trim() || null;
const collectionSlug = normalizeCollectionSlug(getArg("--collection-slug") ?? CORE_COLLECTION_SLUG);

const orderNumberVariants = Array.from(
  new Set(
    [
      orderNumber,
      orderNumber.startsWith("#") ? orderNumber.slice(1) : `#${orderNumber}`,
      orderId
    ].filter((value): value is string => Boolean(value))
  )
);

const run = async () => {
  const existing = await prisma.artwork.findMany({
    where: {
      assigned_order_id: {
        in: orderNumberVariants
      }
    },
    select: {
      iris_id: true,
      status: true
    },
    take: 10
  });

  if (existing.length > 0) {
    throw new Error(
      `Order ${orderNumber} already has assigned artwork: ${existing
        .map((item) => `${item.iris_id} (${item.status})`)
        .join(", ")}`
    );
  }

  const collection = CORE_COLLECTION_ALIASES.has(collectionSlug)
    ? null
    : await prisma.collection.findUnique({
        where: { slug: collectionSlug }
      });

  if (!CORE_COLLECTION_ALIASES.has(collectionSlug) && !collection) {
    throw new Error(`Collection not found: ${collectionSlug}`);
  }

  let recoveredIrisId: string | null = null;
  let generatedPin: string | null = null;

  await prisma.$transaction(async (tx) => {
    const rows = collection
      ? await tx.$queryRaw<{ iris_id: string }[]>`
          SELECT "iris_id" FROM "Artwork"
          WHERE "status" = 'available' AND "collection_id" = ${collection.id}
          ORDER BY random()
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `
      : await tx.$queryRaw<{ iris_id: string }[]>`
          SELECT "iris_id" FROM "Artwork"
          WHERE "status" = 'available' AND "collection_id" IS NULL
          ORDER BY random()
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;

    const irisId = rows[0]?.iris_id;
    if (!irisId) {
      throw new Error(`No available artwork in ${collection?.slug ?? CORE_COLLECTION_SLUG}`);
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
        assigned_order_id: orderNumber,
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
        actor: "manual_random_recovery",
        payload_json: {
          source: "manual_random_recovery",
          order_id: orderId,
          order_number: orderNumber,
          customer_email: customerEmail,
          collection_slug: collection?.slug ?? CORE_COLLECTION_SLUG,
          collection_name: collection?.name ?? "IRIS Collection"
        }
      }
    });

    if (generatedPin) {
      await tx.event.create({
        data: {
          iris_id: irisId,
          type: "pin_generated",
          actor: "manual_random_recovery",
          payload_json: {
            pin_last4: pinCode.slice(-4)
          }
        }
      });
    }

    recoveredIrisId = irisId;
  });

  console.log(
    `Recovered random ${recoveredIrisId} for order ${orderNumber}${customerEmail ? ` (${customerEmail})` : ""}.`
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
