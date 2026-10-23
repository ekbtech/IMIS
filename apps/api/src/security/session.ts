import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "imis_session";

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
