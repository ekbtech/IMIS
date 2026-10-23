import { describe, expect, it } from "vitest";
import { loginSchema } from "./login-schema";

describe("sign-in validation", () => {
  it("rejects blank credentials", () => {
    expect(loginSchema.safeParse({ username: " ", password: "" }).success).toBe(false);
  });

  it("trims the username and accepts non-empty credentials", () => {
    expect(loginSchema.parse({ username: "  nurse.one  ", password: "synthetic-test-password" })).toEqual({
      username: "nurse.one",
      password: "synthetic-test-password",
    });

  });

  it("accepts an optional six-digit authenticator code", () => {
    expect(loginSchema.safeParse({
      username: "nurse.one",
      password: "synthetic-test-password",
      otp: "123456",
    }).success).toBe(true);
    expect(loginSchema.safeParse({
      username: "nurse.one",
      password: "synthetic-test-password",
      otp: "invalid",
    }).success).toBe(false);
  });
});
