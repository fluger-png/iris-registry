CREATE TABLE "CollectionStorefrontOrder" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "collection_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollectionStorefrontOrder_pkey" PRIMARY KEY ("id")
);

-- Preserve the current storefront once. Subsequent order is entirely admin-controlled.
INSERT INTO "CollectionStorefrontOrder" ("id", "collection_ids")
SELECT 'global', COALESCE(array_agg("id" ORDER BY
    CASE WHEN "slug" = 'iris-the-unseen-edition' THEN 0 ELSE 1 END,
    lower("name"), "id"), ARRAY[]::TEXT[])
FROM "Collection";
