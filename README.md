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

- `POST /apps/iris/activate-verify`
  - Body: `{ iris_id, pin, email }`
  - Verifies PIN, activates artwork, and sends Shopify invite if needed.

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

## Rarity Commitment (Merkle Proof)

We pre-assign rarity to all 10,000 IRIS using a deterministic seed and publish a Merkle root.

1. Seed 10,000 artworks first (set `SEED_COUNT=10000`).
2. Run the rarity commit script with a secret seed:

```bash
RARITY_SEED="your-secret-seed" npm run rarity:commit
```

This will:
- Populate `rarity_code` and `rarity_proof` for each IRIS.
- Store the Merkle root in events (`rarity_merkle_root`).
- Generate `rarity-release.generated.md` and `rarity-root.json` locally.

Public proof page:
- `GET /apps/iris/verify` shows the current Merkle root.

Owner proof:
- Each activated owner gets a unique proof link from their IRIS passport (tokenized).

Publish the root:
- Create a GitHub Release and paste the contents of `rarity-release.generated.md`.
- Attach `rarity-root.json` as a release asset.

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
