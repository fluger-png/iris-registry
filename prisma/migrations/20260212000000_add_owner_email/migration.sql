-- Add owner_email to distinguish buyer vs owner
ALTER TABLE "Artwork" ADD COLUMN "owner_email" TEXT;

CREATE INDEX "Artwork_owner_email_idx" ON "Artwork" ("owner_email");
