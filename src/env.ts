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
  reservationTtlMinutes: Number(process.env.RESERVATION_TTL_MINUTES ?? 20),
  releaseIntervalMinutes: Number(process.env.RELEASE_INTERVAL_MINUTES ?? 2)
};
