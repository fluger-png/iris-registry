-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('draft', 'active', 'sold_out', 'archived');

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "artist_name" TEXT,
    "edition_size" INTEGER NOT NULL,
    "artworks_count" INTEGER NOT NULL DEFAULT 1,
    "status" "CollectionStatus" NOT NULL DEFAULT 'draft',
    "shopify_product_id" TEXT,
    "shopify_handle" TEXT,
    "default_price_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Artwork" ADD COLUMN "collection_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Collection_slug_key" ON "Collection"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_shopify_product_id_key" ON "Collection"("shopify_product_id");

-- CreateIndex
CREATE INDEX "Collection_status_idx" ON "Collection"("status");

-- CreateIndex
CREATE INDEX "Artwork_collection_id_status_idx" ON "Artwork"("collection_id", "status");

-- AddForeignKey
ALTER TABLE "Artwork" ADD CONSTRAINT "Artwork_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
