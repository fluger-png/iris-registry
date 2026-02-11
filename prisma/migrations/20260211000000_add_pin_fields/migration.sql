-- AlterTable
ALTER TABLE "Artwork"
ADD COLUMN "pin_code" TEXT,
ADD COLUMN "pin_last4" TEXT,
ADD COLUMN "pin_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pin_locked_until" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Artwork_pin_locked_until_idx" ON "Artwork"("pin_locked_until");
