import { describe, expect, it } from "vitest";
import { canAccessDepartment, canAccessFacility, canAccessSensitiveRecord, canUsePermission, hasPermission, type Principal } from "../src/security/access-control.js";

const principal: Principal = {
  userId: 42,
  sessionId: 100,
  permissions: new Set(["clinical.gbv.read"]),
  facilityIds: new Set([1]),
  departmentAssignments: new Set(["1:7"]),
  mfaRequired: false,
  mfaVerified: false,
  mfaEnrolled: false,
  mustChangePassword: false,
};

describe("access control", () => {
  it("denies permissions that were not explicitly granted", () => {
    expect(hasPermission(principal, "clinical.patient.read")).toBe(false);
  });

  it("scopes access to assigned facilities", () => {
    expect(canAccessFacility(principal, 1)).toBe(true);
    expect(canAccessFacility(principal, 2)).toBe(false);
  });

  it("scopes department access to the facility and department assignment", () => {
    expect(canAccessDepartment(principal, 1, 7)).toBe(true);
    expect(canAccessDepartment(principal, 1, 8)).toBe(false);
    expect(canAccessDepartment(principal, 2, 7)).toBe(false);
  });

  it("requires both a sensitive permission and facility assignment", () => {
    expect(canAccessSensitiveRecord(principal, "clinical.gbv.read", 1)).toBe(true);
    expect(canAccessSensitiveRecord(principal, "clinical.gbv.read", 2)).toBe(false);
    expect(canAccessSensitiveRecord(principal, "clinical.hiv.read", 1)).toBe(false);
  });

  it("blocks privileged access until required MFA and temporary password changes are complete", () => {
    expect(canUsePermission(principal, "clinical.gbv.read")).toBe(true);
    expect(canUsePermission({ ...principal, mfaRequired: true }, "clinical.gbv.read")).toBe(false);
    expect(canUsePermission({ ...principal, mfaRequired: true, mfaVerified: true }, "clinical.gbv.read")).toBe(true);
    expect(canUsePermission({ ...principal, mustChangePassword: true }, "clinical.gbv.read")).toBe(false);
  });
});
