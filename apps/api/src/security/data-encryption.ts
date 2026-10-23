import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function getEncryptionKey(): Buffer {
  const encodedKey = process.env.DATA_ENCRYPTION_KEY;
  if (!encodedKey) throw new Error("DATA_ENCRYPTION_KEY is not configured.");

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function isDataEncryptionConfigured(): boolean {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (!key) return false;
  return Buffer.from(key, "base64").length === 32;
}

export function isPatientLookupKeyConfigured(): boolean {
  const key = process.env.PATIENT_LOOKUP_HMAC_KEY;
  return Boolean(key && Buffer.from(key, "base64").length === 32);
}

export function createPatientLookupHash(value: string): Buffer {
  const encodedKey = process.env.PATIENT_LOOKUP_HMAC_KEY;
  if (!encodedKey) throw new Error("PATIENT_LOOKUP_HMAC_KEY is not configured.");
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("PATIENT_LOOKUP_HMAC_KEY must decode to exactly 32 bytes.");
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function encryptData(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptData(envelope: Buffer): string {
  if (envelope.length < 28) throw new Error("Encrypted data envelope is invalid.");
  const iv = envelope.subarray(0, 12);
  const authTag = envelope.subarray(12, 28);
  const ciphertext = envelope.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
