import { describe, expect, it } from "vitest";
import {
  diagnosticFacilityIdSchema,
  diagnosticIdempotencyKeySchema,
  diagnosticOrderSchema,
} from "../src/validation/diagnostics.js";

describe("disabled diagnostics scaffold validation", () => {
  it("accepts a positive facility ID and UUID service reference", () => {
    expect(diagnosticFacilityIdSchema.safeParse("12").success).toBe(true);
    expect(diagnosticOrderSchema.safeParse({
      serviceId: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
    }).success).toBe(true);
  });

  it("rejects invalid IDs, malformed service IDs, and unexpected clinical fields", () => {
    expect(diagnosticFacilityIdSchema.safeParse("0").success).toBe(false);
    expect(diagnosticFacilityIdSchema.safeParse("1.5").success).toBe(false);
    expect(diagnosticOrderSchema.safeParse({ serviceId: "invalid" }).success).toBe(false);
    expect(diagnosticOrderSchema.safeParse({
      serviceId: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
      interpretation: "unexpected",
    }).success).toBe(false);
  });

  it("requires UUID idempotency keys", () => {
    expect(diagnosticIdempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(diagnosticIdempotencyKeySchema.safeParse("retry").success).toBe(false);
  });
});
