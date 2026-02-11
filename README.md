# IRIS Registry Backend

Fastify + TypeScript service for IRIS ownership registry (Shopify handles payments/shipping only).

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Create `.env` from `.env.example` and update values.

3. Run Prisma migrations and generate client.

```bash
npx prisma generate
npx prisma migrate dev
```

4. Start the API.

```bash
npm run dev
```

## Endpoints

- `POST /apps/iris/reserve-random`
  - Reserves a random available artwork for 20 minutes.
  - Response: `{ reservationToken, irisId }`

- `POST /webhooks/shopify/orders-paid`
  - Validates Shopify HMAC using raw body.
  - Idempotent via `x-shopify-webhook-id`.
  - Extracts `reservationToken` from line item properties.

- `POST /activate`
  - Body: `{ iris_id, pin, actor_email? }`
  - Marks artwork as activated and logs an event.

- `GET /apps/iris/seen-archive?limit=&cursor=`
  - Returns activated artworks with cursor pagination.

- `GET /apps/iris/my-iris?email=`
  - Returns activated artworks for the email.

## Notes

- Reservations expire after `RESERVATION_TTL_MINUTES` and are released by a background interval.
- Ownership is granted only after activation (NFC flow assumed validated).
- Schema is designed to be extendable (marketplace not implemented).

## Admin

- Admin UI: `GET /admin` (Basic Auth required).
- Upload IRIS image via the admin table (stored in Cloudflare R2 and saved to `image_url`).

## Local Development Checklist

- `npm install`
- `DATABASE_URL` configured in `.env`
- `npx prisma migrate dev`
- `npm run dev`
- `ngrok` tunnel
- Shopify webhook + app proxy configured

## Tests

```bash
npm test
```
