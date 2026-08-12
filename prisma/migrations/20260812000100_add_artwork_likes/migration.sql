CREATE TABLE "ArtworkLike" (
    "id" TEXT NOT NULL,
    "iris_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtworkLike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtworkLike_iris_id_user_id_key" ON "ArtworkLike"("iris_id", "user_id");
CREATE INDEX "ArtworkLike_iris_id_idx" ON "ArtworkLike"("iris_id");
CREATE INDEX "ArtworkLike_user_id_idx" ON "ArtworkLike"("user_id");

ALTER TABLE "ArtworkLike" ADD CONSTRAINT "ArtworkLike_iris_id_fkey" FOREIGN KEY ("iris_id") REFERENCES "Artwork"("iris_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtworkLike" ADD CONSTRAINT "ArtworkLike_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "IrisUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
