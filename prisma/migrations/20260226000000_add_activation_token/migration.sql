-- Add activation token for unique activation links
ALTER TABLE "Artwork" ADD COLUMN "activation_token" TEXT;
CREATE UNIQUE INDEX "Artwork_activation_token_key" ON "Artwork"("activation_token");
