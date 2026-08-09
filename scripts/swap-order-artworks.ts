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

const hasFlag = (flag: string): boolean => args.includes(flag);

const required = (flag: string): string => {
  const value = getArg(flag);
  if (!value?.trim()) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value.trim();
};

const normalizeIrisId = (value: string): string => {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) {
    throw new Error("Empty IRIS id");
  }
  if (/^\d{1,4}$/.test(trimmed)) {
    return `IRIS-${trimmed.padStart(4, "0")}`;
  }
  if (/^IRIS-\d{1,4}$/.test(trimmed)) {
    return `IRIS-${trimmed.replace(/^IRIS-/i, "").padStart(4, "0")}`;
  }
  return trimmed;
};

const parseIrisList = (flag: string): string[] =>
  Array.from(
    new Set(
      required(flag)
        .split(",")
        .map((value) => normalizeIrisId(value))
    )
  );

const parseDateArg = (value: string | null): Date | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --order-date value: ${value}`);
  }
  return parsed;
};

const generateActivationToken = (): string => crypto.randomBytes(16).toString("hex");
const generatePin = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const orderNumber = required("--order-number");
const customerEmail = getArg("--email")?.trim().toLowerCase() || null;
const orderId = getArg("--order-id")?.trim() || null;
const orderDate = parseDateArg(getArg("--order-date"));
const orderDateIso = orderDate ? orderDate.toISOString() : null;
const apply = hasFlag("--apply");
const targetIrisIds = parseIrisList("--target-iris");
const releaseIrisIds = parseIrisList("--release-iris");

const orderLookupValues = Array.from(
  new Set(
    [
      orderNumber,
      orderNumber.startsWith("#") ? orderNumber.slice(1) : `#${orderNumber}`,
      orderId
    ].filter((value): value is string => Boolean(value))
  )
);

const run = async () => {
  if (targetIrisIds.length === 0) {
    throw new Error("At least one --target-iris value is required");
  }
  if (releaseIrisIds.length === 0) {
    throw new Error("At least one --release-iris value is required");
  }
  if (targetIrisIds.length !== releaseIrisIds.length) {
    throw new Error("--target-iris and --release-iris must contain the same number of IRIS ids");
  }

  const allIrisIds = Array.from(new Set([...targetIrisIds, ...releaseIrisIds]));
  const artworks = await prisma.artwork.findMany({
    where: {
      iris_id: {
        in: allIrisIds
      }
    },
    select: {
      iris_id: true,
      status: true,
      assigned_order_id: true,
      assigned_customer_email: true,
      owner_email: true,
      activated_at: true,
      pin_code: true,
      activation_token: true,
      collection: {
        select: {
          slug: true,
          name: true
        }
      }
    }
  });

  const artworkById = new Map(artworks.map((artwork) => [artwork.iris_id, artwork]));
  const missing = allIrisIds.filter((irisId) => !artworkById.has(irisId));
  if (missing.length > 0) {
    throw new Error(`Artwork not found: ${missing.join(", ")}`);
  }

  for (const irisId of releaseIrisIds) {
    const artwork = artworkById.get(irisId)!;
    if (artwork.status === "activated") {
      throw new Error(`${irisId} is activated and cannot be released`);
    }
    if (!artwork.assigned_order_id || !orderLookupValues.includes(artwork.assigned_order_id)) {
      throw new Error(
        `${irisId} is not assigned to ${orderNumber}; current order is ${artwork.assigned_order_id ?? "empty"}`
      );
    }
  }

  for (const irisId of targetIrisIds) {
    const artwork = artworkById.get(irisId)!;
    const tiedToSameOrder =
      artwork.assigned_order_id !== null && orderLookupValues.includes(artwork.assigned_order_id);
    if (artwork.status === "activated") {
      throw new Error(`${irisId} is already activated and cannot be reassigned`);
    }
    if (artwork.assigned_order_id && !tiedToSameOrder) {
      throw new Error(`${irisId} is tied to another order: ${artwork.assigned_order_id}`);
    }
    if (artwork.owner_email && !tiedToSameOrder) {
      throw new Error(`${irisId} already has owner_email ${artwork.owner_email}`);
    }
  }

  const plan = {
    mode: apply ? "apply" : "dry-run",
    order_number: orderNumber,
    order_lookup_values: orderLookupValues,
    customer_email: customerEmail,
    release: releaseIrisIds.map((irisId) => artworkById.get(irisId)),
    assign: targetIrisIds.map((irisId) => artworkById.get(irisId))
  };

  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry run only. Re-run with --apply to write this swap.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const irisId of releaseIrisIds) {
      await tx.artwork.update({
        where: { iris_id: irisId },
        data: {
          status: "available",
          assigned_order_id: null,
          assigned_customer_email: null,
          owner_email: null,
          pin_attempts: 0,
          pin_locked_until: null
        }
      });

      await tx.event.create({
        data: {
          iris_id: irisId,
          type: "manual_order_reassignment_released",
          actor: "manual_reassignment",
          payload_json: {
            source: "order_swap",
            order_id: orderId,
            order_number: orderNumber,
            order_created_at: orderDateIso,
            customer_email: customerEmail,
            replacement_targets: targetIrisIds
          }
        }
      });
    }

    for (const irisId of targetIrisIds) {
      const artwork = artworkById.get(irisId)!;
      const pinCode = artwork.pin_code ?? generatePin();
      const activationToken = artwork.activation_token ?? generateActivationToken();
      const generatedPin = artwork.pin_code ? null : pinCode;

      await tx.artwork.update({
        where: { iris_id: irisId },
        data: {
          status: "assigned",
          assigned_order_id: orderNumber,
          assigned_customer_email: customerEmail,
          owner_email: null,
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
          actor: "manual_reassignment",
          payload_json: {
            source: "order_swap",
            order_id: orderId,
            order_number: orderNumber,
            order_created_at: orderDateIso,
            customer_email: customerEmail,
            released_iris_ids: releaseIrisIds,
            collection_slug: artwork.collection?.slug ?? "iris-the-unseen-edition",
            collection_name: artwork.collection?.name ?? "IRIS Collection"
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
    }
  });

  console.log(
    `Swapped order ${orderNumber}: released ${releaseIrisIds.join(", ")}; assigned ${targetIrisIds.join(", ")}.`
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
