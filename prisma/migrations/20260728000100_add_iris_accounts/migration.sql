CREATE TABLE "IrisUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "profile_public" BOOLEAN NOT NULL DEFAULT false,
    "shopify_customer_id" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IrisUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IrisAccountSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IrisAccountSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IrisAccountLoginCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IrisAccountLoginCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IrisUser_email_key" ON "IrisUser"("email");
CREATE UNIQUE INDEX "IrisUser_username_key" ON "IrisUser"("username");
CREATE INDEX "IrisUser_email_idx" ON "IrisUser"("email");
CREATE INDEX "IrisUser_username_idx" ON "IrisUser"("username");

CREATE UNIQUE INDEX "IrisAccountSession_token_hash_key" ON "IrisAccountSession"("token_hash");
CREATE INDEX "IrisAccountSession_user_id_idx" ON "IrisAccountSession"("user_id");
CREATE INDEX "IrisAccountSession_expires_at_idx" ON "IrisAccountSession"("expires_at");

CREATE INDEX "IrisAccountLoginCode_email_expires_at_idx" ON "IrisAccountLoginCode"("email", "expires_at");
CREATE INDEX "IrisAccountLoginCode_expires_at_idx" ON "IrisAccountLoginCode"("expires_at");

ALTER TABLE "IrisAccountSession" ADD CONSTRAINT "IrisAccountSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "IrisUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
