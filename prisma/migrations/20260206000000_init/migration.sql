-- CreateEnum
CREATE TYPE "ArtworkStatus" AS ENUM ('available', 'reserved', 'assigned', 'activated');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('active', 'confirmed', 'expired');

-- CreateTable
CREATE TABLE "Artwork" (
  "iris_id" TEXT NOT NULL,
  "status" "ArtworkStatus" NOT NULL,
  "rarity_code" TEXT,
  "image_url" TEXT,
  "assigned_order_id" TEXT,
  "assigned_customer_email" TEXT,
  "activated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Artwork_pkey" PRIMARY KEY ("iris_id")
);

-- CreateTable
CREATE TABLE "Event" (
  "event_id" UUID NOT NULL,
  "iris_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "Reservation" (
  "token" UUID NOT NULL,
  "iris_id" TEXT NOT NULL,
  "status" "ReservationStatus" NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Reservation_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
  "id" SERIAL NOT NULL,
  "topic" TEXT NOT NULL,
  "shopify_webhook_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artwork_status_idx" ON "Artwork"("status");

-- CreateIndex
CREATE INDEX "Artwork_assigned_customer_email_idx" ON "Artwork"("assigned_customer_email");

-- CreateIndex
CREATE INDEX "Artwork_activated_at_idx" ON "Artwork"("activated_at");

-- CreateIndex
CREATE INDEX "Event_iris_id_idx" ON "Event"("iris_id");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "Reservation_iris_id_idx" ON "Reservation"("iris_id");

-- CreateIndex
CREATE INDEX "Reservation_status_idx" ON "Reservation"("status");

-- CreateIndex
CREATE INDEX "Reservation_expires_at_idx" ON "Reservation"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_shopify_webhook_id_key" ON "WebhookReceipt"("shopify_webhook_id");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_iris_id_fkey" FOREIGN KEY ("iris_id") REFERENCES "Artwork"("iris_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_iris_id_fkey" FOREIGN KEY ("iris_id") REFERENCES "Artwork"("iris_id") ON DELETE CASCADE ON UPDATE CASCADE;
