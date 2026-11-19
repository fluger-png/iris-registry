ALTER TYPE "ArtworkStatus" ADD VALUE IF NOT EXISTS 'retail_stock';

CREATE TABLE "RetailBatch" (
  "id" TEXT NOT NULL,
  "collection_id" TEXT NOT NULL,
  "retailer" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetailBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetailBatch_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "RetailBatchItem" (
  "iris_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "sold_at" TIMESTAMP(3),
  "sold_by" TEXT,
  CONSTRAINT "RetailBatchItem_pkey" PRIMARY KEY ("iris_id"),
  CONSTRAINT "RetailBatchItem_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "RetailBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RetailBatchItem_iris_id_fkey" FOREIGN KEY ("iris_id") REFERENCES "Artwork"("iris_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RetailBatch_collection_id_idx" ON "RetailBatch"("collection_id");
CREATE INDEX "RetailBatchItem_batch_id_idx" ON "RetailBatchItem"("batch_id");
CREATE INDEX "RetailBatchItem_sold_at_idx" ON "RetailBatchItem"("sold_at");
