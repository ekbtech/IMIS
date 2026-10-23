import { describe, expect, it } from "vitest";
import {
  encounterUuidSchema,
  observationIdempotencyKeySchema,
  observationRecordSchema,
} from "../src/validation/observation.js";

describe("encounter observation validation", () => {
  it("requires at least one measurement", () => {
    expect(observationRecordSchema.safeParse({}).success).toBe(false);
    expect(observationRecordSchema.safeParse({ pulseBpm: 72 }).success).toBe(true);
  });

  it("requires blood pressure to be recorded as a pair", () => {
    expect(observationRecordSchema.safeParse({ systolicBpMmhg: 120 }).success).toBe(false);
    expect(observationRecordSchema.safeParse({
      systolicBpMmhg: 120,
      diastolicBpMmhg: 80,
    }).success).toBe(true);
  });

  it("enforces the oxygen saturation unit scale and rejects unknown fields", () => {
    expect(observationRecordSchema.safeParse({ oxygenSaturationPercent: 98 }).success).toBe(true);
    expect(observationRecordSchema.safeParse({ oxygenSaturationPercent: 101 }).success).toBe(false);
    expect(observationRecordSchema.safeParse({ pulseBpm: 72, patientId: 1 }).success).toBe(false);
    expect(observationRecordSchema.safeParse({ weightKg: 2.345 }).success).toBe(false);
    expect(observationRecordSchema.safeParse({ heightCm: 10000 }).success).toBe(false);
  });

  it("requires UUIDs for encounter identifiers and idempotency keys", () => {
    expect(encounterUuidSchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(encounterUuidSchema.safeParse("encounter-1").success).toBe(false);
    expect(observationIdempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(observationIdempotencyKeySchema.safeParse("retry").success).toBe(false);
  });
});
