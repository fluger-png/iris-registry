-- Store merkle proof for rarity verification
ALTER TABLE "Artwork" ADD COLUMN "rarity_proof" JSONB;

ALTER TABLE "Artwork" ADD COLUMN "proof_token" TEXT;
CREATE UNIQUE INDEX "Artwork_proof_token_key" ON "Artwork" ("proof_token");
