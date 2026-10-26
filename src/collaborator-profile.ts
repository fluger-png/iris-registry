import crypto from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

export const PARTNER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const PARTNER_DESCRIPTION_MAX_LENGTH = 2000;

export type CollaboratorProfileView = {
  avatarUrl: string | null;
  description: string;
  available: boolean;
};

export const loadCollaboratorProfile = async (db: PrismaClient, userId: string): Promise<CollaboratorProfileView> => {
  try {
    const profile = await db.collaboratorProfile.findUnique({ where: { user_id: userId } });
    return { avatarUrl: profile?.avatar_url ?? null, description: profile?.description ?? "", available: true };
  } catch (error) {
    // Keep existing logins and collection pages working during the additive migration.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      return { avatarUrl: null, description: "", available: false };
    }
    throw error;
  }
};

export const collaboratorProfileCsrf = (sessionHash: string): string =>
  crypto.createHmac("sha256", sessionHash).update("collaborator-profile").digest("hex");

export const validCollaboratorProfileCsrf = (value: unknown, sessionHash: string): boolean => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  return crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(collaboratorProfileCsrf(sessionHash), "hex"));
};

export const detectPartnerAvatarType = (data: Buffer): { extension: string; contentType: string } | null => {
  if (data.length < 12 || data.length > PARTNER_AVATAR_MAX_BYTES) return null;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", contentType: "image/png" };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
};
