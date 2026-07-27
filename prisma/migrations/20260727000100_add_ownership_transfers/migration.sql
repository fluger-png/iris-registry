-- CreateTable
CREATE TABLE "OwnershipTransfer" (
    "id" TEXT NOT NULL,
    "iris_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "from_email" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_last4" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnershipTransfer_iris_id_status_idx" ON "OwnershipTransfer"("iris_id", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_to_email_status_idx" ON "OwnershipTransfer"("to_email", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_expires_at_idx" ON "OwnershipTransfer"("expires_at");

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_iris_id_fkey" FOREIGN KEY ("iris_id") REFERENCES "Artwork"("iris_id") ON DELETE CASCADE ON UPDATE CASCADE;
