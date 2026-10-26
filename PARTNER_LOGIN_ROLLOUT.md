# Multi-collection Partner Login (2026-10-26)

## Intended First Account

- Company: Gugoco.
- Existing collection slugs: `ararat-heart`, `sayat-nova`.
- Email: `info@gugoco.com`, confirmed by the user on 2026-10-26.
- One invitation and password; no Shopify customer account required.
- Initial dashboard displays only granted collections and their activation counts.
- Artwork editing, orders, payouts, and core Unseen Edition permissions are not part of this change.

## Deployment Gate

The backup at `../backups/2026-10-26` contains code and themes, NOT production database data.
Before applying the migration, take and verify a recovery point of the current production Neon database.
Do not use the old Azure project or local `.env` for this step. Record the active Render deploy as well.

Gate completed on 2026-10-26: Neon confirmed the manual snapshot
`production at 2026-10-26 21:15:16 UTC (manual)`, expiration `never`, in the active AWS project Iris.
Render's database hostname matched the production compute. Pre-rollout live code: `7cdb95d`.
Recovery notes and screenshot are stored separately in the backup directory. No restore was performed.

After the tested code is deployed to Render, inspect migration status in Render Shell:

```sh
cd ~/project/src
npx prisma migrate status
```

The intended new migration is `20261026000100_add_collaborator_collection_access`.
If other unexpected migrations are pending, investigate before applying them.
With the production backup verified:

```sh
npx prisma migrate deploy
```

This adds one join table and copies legacy collection grants into it. It does not change artworks,
orders, customers, ownership, passwords, or existing collection IDs.
Legacy `CollaboratorUser.collection_id` is retained. Existing single-collection logins continue
working if the new table has not been created yet; new multi-collection accounts fail closed.

## Provisioning

1. Open `/admin/collaborators/new` as super-admin.
2. Enter `Gugoco` and the confirmed email.
3. Select the existing Ararat Heart and Sayat Nova collections. Do not create duplicate collections.
4. Submit once and verify the invitation delivery result.
5. The recipient opens the one-time invitation, chooses a password, and enters `/partner`.
6. Subsequent sign-ins use `/partner/login`.

No Gugoco account or email has been created/sent during local implementation.
Customer accounts in My IRIS are separate from collaborator users.

## Permissions And Compatibility

All dashboard queries derive collection IDs from the authenticated user's stored grants, never
from query parameters. No grants means no artworks, not `collection_id = NULL` or all collections.
Legacy grants and new grants are combined and deduplicated. To revoke a legacy grant in future,
both the old primary relation and the new grant must be handled together.
Disabled users cannot log in, use existing sessions, or redeem old invitations.
Reissuing/accepting an invitation revokes old sessions. Invitation acceptance is conditional and
atomic to prevent concurrent reuse.

Code rollback can leave the additive table in place. New multi-collection accounts will be unable
to use the older dashboard until the new code is restored; existing legacy accounts remain valid.
Do not drop the table or restore an old database over new orders/activations as a code rollback.

## Checks

- `npm run build`
- `npx prisma validate`
- `npm test`
- Route tests use a mocked database and do not create production data or send emails.
- A real production migration and invitation delivery still require the deployment/provisioning steps above.
