import { describe, expect, it } from "vitest";
import {
  encounterQueueSchema,
  encounterRegistrationSchema,
  idempotencyKeySchema,
} from "../src/validation/encounter.js";

describe("encounter registration validation", () => {
  it("accepts only outpatient or emergency encounter types", () => {
    expect(encounterRegistrationSchema.safeParse({
      facilityId: 1,
      patientId: 10,
      encounterType: "outpatient",
    }).success).toBe(true);
    expect(encounterRegistrationSchema.safeParse({
      facilityId: 1,
      patientId: 10,
      encounterType: "inpatient",
    }).success).toBe(false);
  });

  it("requires positive integer patient and facility identifiers", () => {
    expect(encounterRegistrationSchema.safeParse({
      facilityId: 1,
      patientId: 10,
      encounterType: "emergency",
    }).success).toBe(true);
    expect(encounterRegistrationSchema.safeParse({
      facilityId: 0,
      patientId: -2,
      encounterType: "emergency",
    }).success).toBe(false);
  });

  it("validates facility queue filters and UUID idempotency keys", () => {
    expect(encounterQueueSchema.safeParse({ facilityId: "2" }).success).toBe(true);
    expect(encounterQueueSchema.safeParse({ facilityId: "0" }).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
