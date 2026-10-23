import { describe, expect, it } from "vitest";
import { createTotpCode, createTotpSecret, decodeBase32, encodeBase32, verifyTotpCode } from "./totp.js";

describe("TOTP primitives", () => {
  it("round-trips Base32 secrets", () => {
    const bytes = Buffer.from("Kenya healthcare security", "utf8");
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
  });

  it("generates high-entropy secrets and validates current codes", () => {
    const secret = createTotpSecret();
    const now = 1_700_000_000_000;
    const { code, step } = createTotpCode(secret, now);

    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(verifyTotpCode(secret, code, now)).toBe(step);
    expect(verifyTotpCode(secret, code, now, step)).toBeNull();
    expect(verifyTotpCode(secret, "123", now)).toBeNull();
    expect(verifyTotpCode("not-a-secret", code, now)).toBeNull();
  });

  it("matches an RFC 6238 SHA-1 test vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const timestamp = 59_000;
    const { code, step } = createTotpCode(secret, timestamp);
    expect(code).toBe("287082");
    expect(verifyTotpCode(secret, code, timestamp)).toBe(step);
  });
});
