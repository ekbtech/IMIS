import { describe, expect, it } from "vitest";
import {
  triageAssessmentUuidSchema,
  triageObservationSchema,
} from "../src/validation/triage.js";

describe("triage capture validation", () => {
  it("accepts observations without interpreting acuity", () => {
    expect(triageObservationSchema.safeParse({
      pulseBpm: 72,
      temperatureCelsius: 36.8,
    }).success).toBe(true);
  });

  it("requires at least one measurement and paired blood-pressure values", () => {
    expect(triageObservationSchema.safeParse({}).success).toBe(false);
    expect(triageObservationSchema.safeParse({ systolicBpMmhg: 120 }).success).toBe(false);
  });

  it("rejects acuity, disposition and other unapproved clinical fields", () => {
    expect(triageObservationSchema.safeParse({
      pulseBpm: 72,
      acuity: "urgent",
    }).success).toBe(false);
    expect(triageObservationSchema.safeParse({
      pulseBpm: 72,
      disposition: "admit",
    }).success).toBe(false);
  });

  it("accepts only UUID triage identifiers", () => {
    expect(triageAssessmentUuidSchema.safeParse("8a324ae8-24b3-49e3-9d75-c3e767e5232b").success).toBe(true);
    expect(triageAssessmentUuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
