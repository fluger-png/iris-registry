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

## My IRIS Discount Pilot

- The offer is restricted server-side to the signed-in pilot account (`info@gugoco.com`). The current pilot is always 10%; holdings do not change the rate yet.
- Uses the existing Shopify client-credentials integration (`SHOPIFY_AUTH_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`). Grant `write_discounts` (includes read access) and ensure the app has `read_customers` or `write_customers`. Do not replace the legacy token or webhook secret.
- On Render, `npm run promo:check` verifies the scopes, customer and discount lookup without issuing a code or printing credentials.
- A code is created only after clicking Redeem My Discount. It is restricted to the matching Shopify customer, one checkout, with no discount combinations. Reopening the modal looks up the same code; an expired/deactivated or used code is not automatically replaced.
- No database migration. The code is derived from the Shopify client secret for this pilot. If rotating that secret or ending the pilot, deactivate the existing discount in Shopify to prevent it from remaining usable. Keep the record when deactivating; deleting it permits a fresh issue.

## Retail Batches

- Apply `npx prisma migrate deploy` after deploying the retail release. The migration adds `retail_stock` and two additive batch tables; it does not allocate artworks or change existing orders.
- Global admin: `/admin/retail`. Partners: `/partner/retail`, restricted to their explicitly granted collections. PIN / NFC CSV exports are global-admin only and never cached.
- `/admin` defaults to the legacy main collection (`collection_id = NULL`). Select a collection or All collections; search, status tabs and detail navigation preserve this selection.
- Allocate existing, clean, unreserved artworks without replacement; do not mint new serials. In the active Render Shell, preview the batch:

```bash
npm run retail:batch -- --collection the-art-of-adornment --quantity 25 --reference OKG-RETAIL-001 --retailer "OKG Jewelry"
```

- The preview does not select or change serials. After reviewing the count, append `--apply` to allocate randomly in one transaction. The script writes a scoped pre-change backup before mutation and exports production credentials into ignored, private `retail-private/` files. Render's filesystem is ephemeral: retain the backup securely outside Render before redeployment. The label CSV can be downloaded again from global admin.
- Retry using the SAME batch reference: it returns the existing batch and does not issue another 25 artworks or regenerate PINs/tokens. Changed settings for an existing reference are rejected.
- Allocation changes `available` to `retail_stock`, generating PIN and NFC URL but not ownership, activation, a fake Shopify order, or a buyer email. Online allocation selects only `available`. In-store stock cannot activate until a sale is recorded. The legacy `/activate` shortcut rejects all retail-batch works; customers must use the NFC + PIN verification endpoint.
- Before handing over the batch, reconcile Shopify's online inventory separately. This release DOES NOT adjust Shopify quantities or require new inventory scopes. Reduce the current available online quantity by the newly allocated count (100 -> 75 only if the current quantity really is 100); keep inventory tracking on and overselling off. Do not reduce it again on an idempotent retry or on the subsequent retail sale.
- Mark sold at the physical checkout in Retail Stock. This moves the artwork to `assigned` and records a dated retail sale; then the buyer uses the normal activation flow and becomes its owner. Repeated sale submissions do not create additional sale events. Allocated stock is not included in purchased counts/average weights; recorded retail sales are.
- This is stock and sale-channel tracking, not wholesale payment/consignment accounting. No customer purchase emails or Shopify paid-order events are fabricated.

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
