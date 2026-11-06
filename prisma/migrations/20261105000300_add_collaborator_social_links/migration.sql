CREATE TABLE "CollaboratorSocialLinks" (
    "user_id" TEXT NOT NULL,
    "instagram_url" TEXT,
    "website_url" TEXT,
    "tiktok_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaboratorSocialLinks_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "CollaboratorSocialLinks" ADD CONSTRAINT "CollaboratorSocialLinks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "CollaboratorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
