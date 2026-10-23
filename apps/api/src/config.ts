import dotenv from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

dotenv.config({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
});

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().url().optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(12),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

if (
  parsed.data.NODE_ENV === "production" &&
  (!process.env.DATABASE_URL || !process.env.WEB_ORIGIN || process.env.COOKIE_SECURE !== "true" ||
    Buffer.from(process.env.DATA_ENCRYPTION_KEY ?? "", "base64").length !== 32 ||
    Buffer.from(process.env.PATIENT_LOOKUP_HMAC_KEY ?? "", "base64").length !== 32)
) {
  throw new Error("Production requires explicit database/origin settings, secure cookies, and 32-byte encryption and patient lookup keys.");
}

export const config = {
  ...parsed.data,
  DATABASE_URL: parsed.data.DATABASE_URL ?? "mysql://imis_app:local-development-only@localhost:3306/imis",
  cookieSecure: parsed.data.COOKIE_SECURE === "true" || parsed.data.NODE_ENV === "production",
};
