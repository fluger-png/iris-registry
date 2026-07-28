ALTER TABLE "IrisUser" ADD COLUMN "avatar_iris_id" TEXT;

CREATE INDEX "IrisUser_avatar_iris_id_idx" ON "IrisUser"("avatar_iris_id");
