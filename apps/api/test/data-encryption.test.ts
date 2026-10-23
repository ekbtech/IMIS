import { afterEach, describe, expect, it } from "vitest";
import { decryptData, encryptData } from "../src/security/data-encryption.js";

const priorKey = process.env.DATA_ENCRYPTION_KEY;

afterEach(() => {
  if (priorKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
  else process.env.DATA_ENCRYPTION_KEY = priorKey;
});

describe("patient-data encryption", () => {
  it("round-trips authenticated AES-256-GCM envelopes", () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const envelope = encryptData("Synthetic patient identity");
    expect(decryptData(envelope)).toBe("Synthetic patient identity");
  });

  it("rejects modified ciphertext", () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const envelope = encryptData("Synthetic patient identity");
    envelope[envelope.length - 1] ^= 1;
    expect(() => decryptData(envelope)).toThrow();
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(31).toString("base64");
    expect(() => encryptData("Synthetic patient identity")).toThrow(/exactly 32 bytes/u);
  });
});
