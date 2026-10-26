CREATE TABLE "CollectionPresentation" (
  "collection_id" TEXT NOT NULL,
  "display_name" TEXT,
  "banner_url" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "gallery_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CollectionPresentation_pkey" PRIMARY KEY ("collection_id"),
  CONSTRAINT "CollectionPresentation_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
