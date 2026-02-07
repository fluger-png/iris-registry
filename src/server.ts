import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { Prisma } from "@prisma/client";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { decodeCursor, encodeCursor, parseReservationToken, verifyShopifyHmac } from "./utils.js";

const MAX_PAGE_SIZE = 100;

const parseLimit = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
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

const recordShopifyOwnership = async (_order: Record<string, unknown>, _irisId: string): Promise<void> => {
  // TODO: integrate Shopify write (metafield/tag/note). Keep as no-op for MVP.
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
    const reservationToken = parseReservationToken(order);
    if (!reservationToken) {
      reply.code(400).send({ error: "missing_reservation_token" });
      return;
    }

    const orderId = order.id ? String(order.id) : null;
    const customerEmail = extractCustomerEmail(order);
    let assignedIrisId: string | null = null;

    try {
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

        await tx.artwork.update({
          where: { iris_id: reservation.iris_id },
          data: {
            status: "assigned",
            assigned_order_id: orderId,
            assigned_customer_email: customerEmail
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
              customer_email: customerEmail
            }
          }
        });

        assignedIrisId = reservation.iris_id;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "reservation_expired") {
        reply.code(409).send({ error: "reservation_expired" });
        return;
      }
      if (error instanceof Error && error.message === "reservation_not_active") {
        reply.code(409).send({ error: "reservation_not_active" });
        return;
      }
      req.log.error({ err: error }, "Failed to confirm reservation");
      reply.code(500).send({ error: "reservation_confirm_failed" });
      return;
    }

    if (assignedIrisId) {
      try {
        await recordShopifyOwnership(order, assignedIrisId);
      } catch (error) {
        req.log.error({ err: error, irisId: assignedIrisId }, "Shopify write failed");
        await prisma.$transaction(async (tx) => {
          await tx.artwork.update({
            where: { iris_id: assignedIrisId },
            data: { status: "shopify_failed" }
          });
          await tx.event.create({
            data: {
              iris_id: assignedIrisId,
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

    reply.send({ status: "ok" });
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
          activated_at: new Date()
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
        assigned_customer_email: query.email
      },
      orderBy: [{ activated_at: "desc" }, { iris_id: "desc" }]
    });

    sendJson(reply, 200, {
      items: items.map((item) => ({
        iris_id: item.iris_id,
        image_url: item.image_url,
        rarity_code: item.rarity_code,
        activated_at: item.activated_at
      }))
    });
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
