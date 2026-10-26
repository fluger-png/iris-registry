-- Additive: keep the legacy single-collection relation for rollback compatibility.
CREATE TABLE "CollaboratorCollectionAccess" (
    "user_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollaboratorCollectionAccess_pkey" PRIMARY KEY ("user_id", "collection_id")
);

CREATE INDEX "CollaboratorCollectionAccess_collection_id_idx" ON "CollaboratorCollectionAccess"("collection_id");

ALTER TABLE "CollaboratorCollectionAccess" ADD CONSTRAINT "CollaboratorCollectionAccess_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "CollaboratorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CollaboratorCollectionAccess" ADD CONSTRAINT "CollaboratorCollectionAccess_collection_id_fkey"
FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CollaboratorCollectionAccess" ("user_id", "collection_id")
SELECT "id", "collection_id" FROM "CollaboratorUser" WHERE "collection_id" IS NOT NULL;
