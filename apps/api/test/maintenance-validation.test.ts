import { describe, expect, it } from "vitest";
import {
  maintenanceIdempotencyKeySchema,
  maintenanceRequestSchema,
  maintenanceTransitionSchema,
} from "../src/validation/maintenance.js";

describe("maintenance request validation", () => {
  it("accepts valid equipment fault reports", () => {
    expect(maintenanceRequestSchema.safeParse({
      reportingDepartmentId: 12,
      assetTag: "EQ-204",
      location: "Outpatient room 4",
      issue: "The examination lamp does not switch on when its control is pressed.",
    }).success).toBe(true);
  });

  it("rejects incomplete reports and unknown fields", () => {
    expect(maintenanceRequestSchema.safeParse({
      reportingDepartmentId: 12,
      assetTag: " ",
      location: "A",
      issue: "Broken",
    }).success).toBe(false);
    expect(maintenanceRequestSchema.safeParse({
      reportingDepartmentId: 12,
      assetTag: "EQ-204",
      location: "Outpatient room 4",
      issue: "The examination lamp does not switch on when its control is pressed.",
      severity: "critical",
    }).success).toBe(false);
  });

  it("requires an idempotency UUID and limits lifecycle actions", () => {
    expect(maintenanceIdempotencyKeySchema.safeParse("e4aa69a9-3f38-4431-b1c0-5fab402a1272").success).toBe(true);
    expect(maintenanceIdempotencyKeySchema.safeParse("not-a-uuid").success).toBe(false);
    expect(maintenanceTransitionSchema.safeParse({ action: "acknowledge" }).success).toBe(true);
    expect(maintenanceTransitionSchema.safeParse({ action: "reopen" }).success).toBe(false);
  });
});
