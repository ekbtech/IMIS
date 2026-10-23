import { describe, expect, it } from "vitest";
import {
  inpatientBedAssignmentSchema,
  inpatientFacilityIdSchema,
  inpatientIdempotencyKeySchema,
} from "../src/validation/inpatient.js";

describe("disabled inpatient scaffold validation", () => {
  it("accepts a positive facility ID and UUID bed reference", () => {
    expect(inpatientFacilityIdSchema.safeParse("5").success).toBe(true);
    expect(inpatientBedAssignmentSchema.safeParse({
      bedId: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
    }).success).toBe(true);
  });

  it("rejects invalid facility IDs, bed references, and extra workflow fields", () => {
    expect(inpatientFacilityIdSchema.safeParse("-1").success).toBe(false);
    expect(inpatientFacilityIdSchema.safeParse("2.5").success).toBe(false);
    expect(inpatientBedAssignmentSchema.safeParse({ bedId: "invalid" }).success).toBe(false);
    expect(inpatientBedAssignmentSchema.safeParse({
      bedId: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
      acuity: "high",
    }).success).toBe(false);
  });

  it("requires UUID idempotency keys", () => {
    expect(inpatientIdempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(inpatientIdempotencyKeySchema.safeParse("retry").success).toBe(false);
  });
});
