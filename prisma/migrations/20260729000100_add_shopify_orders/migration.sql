-- CreateTable
CREATE TABLE "ShopifyOrder" (
    "id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT,
    "order_number" TEXT,
    "email" TEXT,
    "financial_status" TEXT,
    "fulfillment_status" TEXT,
    "currency" TEXT,
    "subtotal_price_cents" INTEGER,
    "total_price_cents" INTEGER,
    "total_tax_cents" INTEGER,
    "processed_at" TIMESTAMP(3),
    "created_at_shopify" TIMESTAMP(3),
    "updated_at_shopify" TIMESTAMP(3),
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyOrderItem" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_line_item_id" TEXT,
    "product_id" TEXT,
    "variant_id" TEXT,
    "title" TEXT,
    "variant_title" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price_cents" INTEGER,
    "total_discount_cents" INTEGER,
    "currency" TEXT,
    "properties_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrder_shopify_order_id_key" ON "ShopifyOrder"("shopify_order_id");

-- CreateIndex
CREATE INDEX "ShopifyOrder_email_idx" ON "ShopifyOrder"("email");

-- CreateIndex
CREATE INDEX "ShopifyOrder_order_name_idx" ON "ShopifyOrder"("order_name");

-- CreateIndex
CREATE INDEX "ShopifyOrder_order_number_idx" ON "ShopifyOrder"("order_number");

-- CreateIndex
CREATE INDEX "ShopifyOrder_created_at_shopify_idx" ON "ShopifyOrder"("created_at_shopify");

-- CreateIndex
CREATE INDEX "ShopifyOrderItem_order_id_idx" ON "ShopifyOrderItem"("order_id");

-- CreateIndex
CREATE INDEX "ShopifyOrderItem_shopify_line_item_id_idx" ON "ShopifyOrderItem"("shopify_line_item_id");

-- CreateIndex
CREATE INDEX "ShopifyOrderItem_product_id_idx" ON "ShopifyOrderItem"("product_id");

-- CreateIndex
CREATE INDEX "ShopifyOrderItem_variant_id_idx" ON "ShopifyOrderItem"("variant_id");

-- AddForeignKey
ALTER TABLE "ShopifyOrderItem" ADD CONSTRAINT "ShopifyOrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ShopifyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
