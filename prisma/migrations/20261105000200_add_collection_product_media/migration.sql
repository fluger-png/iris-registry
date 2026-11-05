CREATE TABLE "CollectionProductMedia" (
  "collection_id" TEXT NOT NULL,
  "video_url" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CollectionProductMedia_pkey" PRIMARY KEY ("collection_id"),
  CONSTRAINT "CollectionProductMedia_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
