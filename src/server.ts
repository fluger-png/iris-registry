import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Prisma } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import path from "node:path";
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

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  }
});

const sanitizeIrisId = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9-]/g, "");

const requireAdmin = async (req: any, reply: any): Promise<boolean> => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="IRIS Admin"').send("Unauthorized");
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user !== env.adminBasicUser || pass !== env.adminBasicPass) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="IRIS Admin"').send("Unauthorized");
    return false;
  }
  return true;
};

const buildAdminHtml = (items: Array<{
  iris_id: string;
  status: string;
  assigned_order_id: string | null;
  assigned_customer_email: string | null;
  activated_at: Date | null;
  image_url: string | null;
  pin_code: string | null;
}>) => {
  const rows = items
    .map((item) => {
      const imageCell = item.image_url
        ? `<img src="${item.image_url}" alt="${item.iris_id}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;" />`
        : "-";
      return `
        <tr>
          <td>${item.iris_id}</td>
          <td>${item.status}</td>
          <td>${item.assigned_customer_email ?? "-"}</td>
          <td>${item.assigned_order_id ?? "-"}</td>
          <td>${item.activated_at ? new Date(item.activated_at).toISOString() : "-"}</td>
          <td>${item.pin_code ?? "-"}</td>
          <td>${imageCell}</td>
          <td>
            <form method="POST" action="/admin/iris/upload" enctype="multipart/form-data">
              <input type="hidden" name="iris_id" value="${item.iris_id}" />
              <input type="file" name="image" accept="image/*" required />
              <button type="submit">Upload</button>
            </form>
          </td>
        </tr>
      `;
    })
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>IRIS Admin</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; background:#f7f7f7; }
        h1 { margin: 0 0 16px; }
        table { width: 100%; border-collapse: collapse; background: #fff; }
        th, td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
        th { background: #fafafa; }
        form { display: flex; gap: 8px; align-items: center; }
        button { padding: 6px 10px; }
      </style>
    </head>
    <body>
      <h1>IRIS Sold Registry</h1>
      <table>
        <thead>
          <tr>
            <th>IRIS ID</th>
            <th>Status</th>
            <th>Customer Email</th>
            <th>Order ID</th>
            <th>Activated At</th>
            <th>PIN</th>
            <th>Image</th>
            <th>Upload</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='7'>No records</td></tr>"}
        </tbody>
      </table>
    </body>
  </html>`;
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

const shopifyGraphQL = async (query: string, variables: Record<string, unknown>) => {
  const url = `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": env.shopifyAdminToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }
  const json = JSON.parse(text) as { errors?: unknown; data?: unknown };
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as Record<string, any>;
};

const shopifyFindCustomerIdByEmail = async (email: string): Promise<string | null> => {
  const q = `
    query ($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id email } }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { q: `email:${email}` });
  const edge = data?.customers?.edges?.[0];
  return edge?.node?.id ?? null;
};

const shopifyCreateCustomer = async (email: string): Promise<string> => {
  const m = `
    mutation ($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(m, { input: { email } });
  const errs = data?.customerCreate?.userErrors;
  if (errs && errs.length) {
    throw new Error(`customerCreate: ${JSON.stringify(errs)}`);
  }
  return data.customerCreate.customer.id as string;
};

const shopifyGetLegacyId = async (customerId: string): Promise<number | null> => {
  const q = `query ($id: ID!) { customer(id: $id) { legacyResourceId } }`;
  const data = await shopifyGraphQL(q, { id: customerId });
  return data?.customer?.legacyResourceId ?? null;
};

const shopifySendInviteBestEffort = async (legacyId: number): Promise<void> => {
  const url = `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/customers/${legacyId}/send_invite.json`;
  await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": env.shopifyAdminToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ customer_invite: {} })
  });
};

const ensureShopifyCustomerInvite = async (email: string): Promise<void> => {
  const existingId = await shopifyFindCustomerIdByEmail(email);
  if (existingId) {
    return;
  }
  const createdId = await shopifyCreateCustomer(email);
  const legacyId = await shopifyGetLegacyId(createdId);
  if (!legacyId) return;
  try {
    await shopifySendInviteBestEffort(legacyId);
  } catch {
    // ignore invite failures
  }
};

const recordShopifyOwnership = async (_order: Record<string, unknown>, _irisId: string): Promise<void> => {
  // Placeholder for future Shopify updates (metafields/tags).
};

const generatePin = (): string => {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, "0");
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
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }
  });

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
    let generatedPin: string | null = null;

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

        const artwork = await tx.artwork.findUnique({
          where: { iris_id: reservation.iris_id }
        });

        const pinCode = artwork?.pin_code ?? generatePin();
        generatedPin = artwork?.pin_code ? null : pinCode;

        await tx.artwork.update({
          where: { iris_id: reservation.iris_id },
          data: {
            status: "assigned",
            assigned_order_id: orderId,
            assigned_customer_email: customerEmail,
            pin_code: pinCode,
            pin_last4: pinCode.slice(-4),
            pin_attempts: 0,
            pin_locked_until: null
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

        if (generatedPin) {
          await tx.event.create({
            data: {
              iris_id: reservation.iris_id,
              type: "pin_generated",
              actor: "system",
              payload_json: {
                pin_last4: pinCode.slice(-4)
              }
            }
          });
        }

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
      const irisId = assignedIrisId;
      try {
        await recordShopifyOwnership(order, irisId);
      } catch (error) {
        req.log.error({ err: error, irisId }, "Shopify write failed");
        await prisma.$transaction(async (tx) => {
          await tx.artwork.update({
            where: { iris_id: irisId },
            data: { status: "shopify_failed" }
          });
          await tx.event.create({
            data: {
              iris_id: irisId,
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
          activated_at: new Date(),
          assigned_customer_email: body.actor_email ? body.actor_email : undefined
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

  const handleActivateVerify = async (req: any, reply: any) => {
    const body = req.body as { iris_id?: string; pin?: string; email?: string };
    const irisId = body?.iris_id?.toUpperCase().trim();
    const pin = body?.pin?.trim();
    const email = body?.email?.trim().toLowerCase();

    if (!irisId || !pin || !email) {
      sendJson(reply, 400, { error: "missing_required_fields" });
      return;
    }

    const MAX_ATTEMPTS = 5;
    const LOCK_MINUTES = 60;

    try {
      const artwork = await prisma.artwork.findUnique({ where: { iris_id: irisId } });
      if (!artwork) {
        sendJson(reply, 404, { error: "iris_not_found" });
        return;
      }

      if (artwork.status === "activated") {
        sendJson(reply, 409, { error: "already_activated" });
        return;
      }

      if (artwork.status !== "assigned") {
        sendJson(reply, 409, { error: "not_assigned" });
        return;
      }

      if (!artwork.pin_code) {
        sendJson(reply, 409, { error: "pin_not_set" });
        return;
      }

      if (artwork.pin_locked_until && artwork.pin_locked_until > new Date()) {
        sendJson(reply, 429, { error: "too_many_attempts", retry_at: artwork.pin_locked_until });
        return;
      }

      if (artwork.pin_code !== pin) {
        const nextAttempts = (artwork.pin_attempts ?? 0) + 1;
        const lockUntil =
          nextAttempts >= MAX_ATTEMPTS
            ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
            : null;

        await prisma.$transaction(async (tx) => {
          await tx.artwork.update({
            where: { iris_id: irisId },
            data: {
              pin_attempts: nextAttempts,
              pin_locked_until: lockUntil
            }
          });
          await tx.event.create({
            data: {
              iris_id: irisId,
              type: "activation_failed",
              actor: email,
              payload_json: {
                reason: "invalid_pin",
                attempts: nextAttempts,
                locked_until: lockUntil
              }
            }
          });
        });

        sendJson(reply, 401, { error: "invalid_pin" });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.artwork.update({
          where: { iris_id: irisId },
          data: {
            status: "activated",
            activated_at: new Date(),
            assigned_customer_email: artwork.assigned_customer_email ?? email,
            pin_attempts: 0,
            pin_locked_until: null
          }
        });
        await tx.event.create({
          data: {
            iris_id: irisId,
            type: "activated",
            actor: email,
            payload_json: {
              actor_email: email
            }
          }
        });
      });

      try {
        await ensureShopifyCustomerInvite(email);
      } catch (inviteErr) {
        req.log.error({ err: inviteErr, email }, "Shopify invite failed");
      }

      sendJson(reply, 200, { status: "ok" });
    } catch (error) {
      req.log.error({ err: error }, "Activation verify failed");
      sendJson(reply, 500, { error: "activation_failed" });
    }
  };

  app.post("/activate-verify", handleActivateVerify);
  app.post("/apps/iris/activate-verify", handleActivateVerify);

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

  app.get("/admin", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const items = await prisma.artwork.findMany({
      where: {
        status: { in: ["assigned", "activated", "shopify_failed"] }
      },
      orderBy: [{ updated_at: "desc" }, { iris_id: "desc" }],
      take: 500
    });

    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        buildAdminHtml(
          items.map((item) => ({
            iris_id: item.iris_id,
            status: item.status,
            assigned_order_id: item.assigned_order_id,
            assigned_customer_email: item.assigned_customer_email,
            activated_at: item.activated_at,
            image_url: item.image_url,
            pin_code: item.pin_code
          }))
        )
      );
  });

  app.post("/admin/iris/upload", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;

    const data = await (req as any).file();
    if (!data) {
      reply.code(400).send("Missing file");
      return;
    }

    const irisIdRaw = data.fields?.iris_id?.value;
    if (!irisIdRaw || typeof irisIdRaw !== "string") {
      reply.code(400).send("Missing iris_id");
      return;
    }

    const irisId = sanitizeIrisId(irisIdRaw);
    if (!irisId) {
      reply.code(400).send("Invalid iris_id");
      return;
    }

    const ext = path.extname(data.filename || "").toLowerCase() || ".jpg";
    const objectKey = `iris/${irisId}/${Date.now()}-${crypto.randomUUID()}${ext}`;

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    await r2.send(
      new PutObjectCommand({
        Bucket: env.r2Bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: data.mimetype || "application/octet-stream"
      })
    );

    const publicBase = env.r2PublicBaseUrl.replace(/\/$/, "");
    const imageUrl = `${publicBase}/${objectKey}`;

    await prisma.artwork.update({
      where: { iris_id: irisId },
      data: { image_url: imageUrl }
    });

    reply.redirect(303, "/admin");
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
