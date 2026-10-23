import { describe, expect, it } from "vitest";
import {
  appointmentRequestSchema,
  appointmentTransitionSchema,
  eatDateTimeToUtc,
} from "../src/validation/appointments.js";

describe("appointment request validation", () => {
  it("accepts a future local East Africa time and a meaningful reason", () => {
    expect(appointmentRequestSchema.safeParse({
      patientId: 1,
      departmentId: 2,
      requestedAt: "2035-05-17T10:30",
      reason: "Follow-up requested after the previous outpatient visit.",
    }).success).toBe(true);
  });

  it("converts East Africa local time to the correct UTC database value", () => {
    expect(eatDateTimeToUtc("2035-05-17T10:30")).toBe("2035-05-17 07:30:00");
  });

  it("rejects invalid calendar dates, past times, and short reasons", () => {
    expect(appointmentRequestSchema.safeParse({
      patientId: 1,
      departmentId: 2,
      requestedAt: "2035-02-30T10:30",
      reason: "Follow-up requested after the previous outpatient visit.",
    }).success).toBe(false);
    expect(appointmentRequestSchema.safeParse({
      patientId: 1,
      departmentId: 2,
      requestedAt: "2020-02-20T10:30",
      reason: "Follow-up requested after the previous outpatient visit.",
    }).success).toBe(false);
    expect(appointmentRequestSchema.safeParse({
      patientId: 1,
      departmentId: 2,
      requestedAt: "2035-05-17T10:30",
      reason: "Short",
    }).success).toBe(false);
  });

  it("requires a reason when declining but permits confirming without one", () => {
    expect(appointmentTransitionSchema.safeParse({ action: "confirm" }).success).toBe(true);
    expect(appointmentTransitionSchema.safeParse({ action: "decline", note: "No" }).success).toBe(false);
    expect(appointmentTransitionSchema.safeParse({
      action: "decline",
      note: "Requested time is not available for the clinic.",
    }).success).toBe(true);
  });
});
