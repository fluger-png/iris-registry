import { config } from "dotenv";

config();

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  databaseUrl: required("DATABASE_URL"),
  shopifyWebhookSecret: required("SHOPIFY_WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  baseStorefrontUrl: process.env.STOREFRONT_URL ?? "https://irisnyc.store",
  reservationTtlMinutes: Number(process.env.RESERVATION_TTL_MINUTES ?? 20),
  releaseIntervalMinutes: Number(process.env.RELEASE_INTERVAL_MINUTES ?? 2),
  adminBasicUser: required("ADMIN_BASIC_USER"),
  adminBasicPass: required("ADMIN_BASIC_PASS"),
  r2AccountId: required("R2_ACCOUNT_ID"),
  r2AccessKeyId: required("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  r2Bucket: required("R2_BUCKET"),
  r2PublicBaseUrl: required("R2_PUBLIC_BASE_URL"),
  shopifyAdminToken: required("SHOPIFY_ADMIN_TOKEN"),
  shopifyShopDomain: required("SHOPIFY_SHOP_DOMAIN"),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2024-10",
  goldApiKey: process.env.GOLDAPI_KEY ?? "",
  adminTimezone: process.env.ADMIN_TIMEZONE ?? "America/New_York",
  partnerPortalBaseUrl: process.env.PARTNER_PORTAL_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:3000",
  partnerInviteTtlHours: Number(process.env.PARTNER_INVITE_TTL_HOURS ?? 24 * 7),
  partnerSessionTtlDays: Number(process.env.PARTNER_SESSION_TTL_DAYS ?? 30),
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "",
  googleAnalyticsId: process.env.GOOGLE_ANALYTICS_ID ?? ""
};
