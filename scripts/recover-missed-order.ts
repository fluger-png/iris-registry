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
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
};

const irisId = required("--iris-id");
const orderNumber = required("--order-number");
const customerEmail = getArg("--email");
const orderId = getArg("--order-id");
const reservationToken = getArg("--reservation-token");

const generateActivationToken = (): string => crypto.randomBytes(16).toString("hex");
const generatePin = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const run = async () => {
  const artwork = await prisma.artwork.findUnique({
    where: { iris_id: irisId },
    include: {
      collection: true,
      reservations: {
        orderBy: { created_at: "desc" },
        take: 5
      }
    }
  });

  if (!artwork) {
    throw new Error(`Artwork not found: ${irisId}`);
  }

  if (
    artwork.assigned_order_id &&
    artwork.assigned_order_id !== orderNumber &&
    artwork.status !== "available" &&
    artwork.status !== "reserved"
  ) {
    throw new Error(
      `Artwork ${irisId} is already tied to ${artwork.assigned_order_id} with status ${artwork.status}`
    );
  }

  if (artwork.status === "activated") {
    throw new Error(`Artwork ${irisId} is already activated and cannot be recovered this way`);
  }

  const pinCode = artwork.pin_code ?? generatePin();
  const activationToken = artwork.activation_token ?? generateActivationToken();
  const generatedPin = artwork.pin_code ? null : pinCode;

  await prisma.$transaction(async (tx) => {
    if (reservationToken) {
      const reservation = await tx.reservation.findUnique({
        where: { token: reservationToken }
      });

      if (reservation && reservation.iris_id !== irisId) {
        throw new Error(
          `Reservation ${reservationToken} belongs to ${reservation.iris_id}, not ${irisId}`
        );
      }

      if (reservation && reservation.status === "active") {
        await tx.reservation.update({
          where: { token: reservationToken },
          data: { status: "confirmed" }
        });
      }
    }

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
        actor: "manual_recovery",
        payload_json: {
          source: "manual_recovery",
          order_id: orderId,
          order_number: orderNumber,
          customer_email: customerEmail,
          reservation_token: reservationToken,
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
          actor: "manual_recovery",
          payload_json: {
            pin_last4: pinCode.slice(-4)
          }
        }
      });
    }
  });

  console.log(
    `Recovered ${irisId} for order ${orderNumber}${customerEmail ? ` (${customerEmail})` : ""}.`
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
