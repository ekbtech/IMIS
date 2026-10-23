import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken } from "../src/security/session.js";

describe("server-side session tokens", () => {
  it("creates high-entropy opaque tokens and stores a digest rather than the bearer value", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first).toHaveLength(43);
    expect(hashSessionToken(first)).not.toBe(first);
    expect(hashSessionToken(first)).toBe(hashSessionToken(first));
  });
});
