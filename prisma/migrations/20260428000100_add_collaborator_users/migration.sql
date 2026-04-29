-- CreateEnum
CREATE TYPE "CollaboratorStatus" AS ENUM ('invited', 'active', 'disabled');

-- CreateTable
CREATE TABLE "CollaboratorUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "collection_id" TEXT,
    "status" "CollaboratorStatus" NOT NULL DEFAULT 'invited',
    "password_hash" TEXT,
    "invited_by" TEXT,
    "invitation_sent_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaboratorUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaboratorInvite" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "sent_to" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollaboratorInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaboratorSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollaboratorSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollaboratorUser_email_key" ON "CollaboratorUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CollaboratorUser_collection_id_key" ON "CollaboratorUser"("collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "CollaboratorInvite_token_hash_key" ON "CollaboratorInvite"("token_hash");

-- CreateIndex
CREATE INDEX "CollaboratorInvite_user_id_idx" ON "CollaboratorInvite"("user_id");

-- CreateIndex
CREATE INDEX "CollaboratorInvite_expires_at_idx" ON "CollaboratorInvite"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "CollaboratorSession_token_hash_key" ON "CollaboratorSession"("token_hash");

-- CreateIndex
CREATE INDEX "CollaboratorSession_user_id_idx" ON "CollaboratorSession"("user_id");

-- CreateIndex
CREATE INDEX "CollaboratorSession_expires_at_idx" ON "CollaboratorSession"("expires_at");

-- AddForeignKey
ALTER TABLE "CollaboratorUser" ADD CONSTRAINT "CollaboratorUser_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaboratorInvite" ADD CONSTRAINT "CollaboratorInvite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "CollaboratorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaboratorSession" ADD CONSTRAINT "CollaboratorSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "CollaboratorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
