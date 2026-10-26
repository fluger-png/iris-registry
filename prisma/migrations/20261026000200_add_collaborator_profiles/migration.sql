CREATE TABLE "CollaboratorProfile" (
    "user_id" TEXT NOT NULL,
    "avatar_url" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CollaboratorProfile_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "CollaboratorProfile" ADD CONSTRAINT "CollaboratorProfile_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "CollaboratorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
