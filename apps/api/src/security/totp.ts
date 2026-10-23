import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const stepSeconds = 30;

export function createTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];

  for (const character of value.toUpperCase().replace(/=+$/u, "")) {
    const digit = base32Alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid Base32 secret.");
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

export function createTotpCode(secret: string, unixTimeMs = Date.now()): { code: string; step: number } {
  const step = Math.floor(unixTimeMs / 1000 / stepSeconds);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;

  return { code: String(binary % 1_000_000).padStart(6, "0"), step };
}

export function verifyTotpCode(
  secret: string,
  submittedCode: string,
  unixTimeMs = Date.now(),
  lastAcceptedStep = -1,
): number | null {
  if (!/^\d{6}$/u.test(submittedCode)) return null;

  const currentStep = Math.floor(unixTimeMs / 1000 / stepSeconds);
  const submitted = Buffer.from(submittedCode, "ascii");

  try {
    const secretBytes = decodeBase32(secret);
    for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
      if (step <= lastAcceptedStep) continue;
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(step));
      const digest = createHmac("sha1", secretBytes).update(counter).digest();
      const offset = digest[digest.length - 1]! & 0x0f;
      const binary = digest.readUInt32BE(offset) & 0x7fffffff;
      const expected = Buffer.from(String(binary % 1_000_000).padStart(6, "0"), "ascii");
      if (timingSafeEqual(submitted, expected)) return step;
    }
  } catch {
    return null;
  }

  return null;
}
