import { describe, expect, it } from "vitest";
import { getDuplicateEvidence, normalizeFullPatientName } from "../src/security/patient-identity.js";
import { patientRegistrationSchema, patientSearchSchema } from "../src/validation/patient.js";

describe("patient identity validation and duplicate evidence", () => {
  it("normalizes whitespace and diacritics for deterministic matching", () => {
    expect(normalizeFullPatientName({ givenName: "  JOSÉ  ", familyName: "  wa   KIMANI " }))
      .toBe("jose wa kimani");
  });

  it("uses exact name and birth-date evidence rather than silently merging", () => {
    expect(getDuplicateEvidence(
      { givenName: "Amina", familyName: "Otieno", dateOfBirth: "2000-01-01" },
      { givenName: " Amina ", familyName: "OTIENO", dateOfBirth: "2000-01-01" },
    )).toEqual({ nameMatches: true, dateOfBirthMatches: true });
  });

  it("requires an explicit per-candidate decision and reason", () => {
    const identity = {
      facilityId: 1,
      givenName: "Amina",
      familyName: "Otieno",
      dateOfBirth: "2000-01-01",
      sexAtRegistration: "female",
    };
    expect(patientRegistrationSchema.safeParse(identity).success).toBe(true);
    expect(patientRegistrationSchema.safeParse({
      ...identity,
      duplicateReviews: [{ candidatePatientId: 12, disposition: "different_person", reason: "Verified distinct county referral identifier." }],
    }).success).toBe(true);
    expect(patientRegistrationSchema.safeParse({
      ...identity,
      duplicateReviews: [{ candidatePatientId: 12, disposition: "different_person", reason: "not sure" }],
    }).success).toBe(false);
  });

  it("requires record number or both names for MPI search", () => {
    expect(patientSearchSchema.safeParse({ facilityId: 1, recordNumber: "FAC-2026-AB12CD34" }).success).toBe(true);
    expect(patientSearchSchema.safeParse({ facilityId: 1, givenName: "Amina" }).success).toBe(false);
  });

  it("rejects invalid and future birth dates", () => {
    expect(patientRegistrationSchema.safeParse({
      facilityId: 1,
      givenName: "Amina",
      familyName: "Otieno",
      dateOfBirth: "2026-02-30",
      sexAtRegistration: "unknown",
    }).success).toBe(false);
    const futureDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(patientRegistrationSchema.safeParse({
      facilityId: 1,
      givenName: "Amina",
      familyName: "Otieno",
      dateOfBirth: futureDate,
      sexAtRegistration: "unknown",
    }).success).toBe(false);
  });
});
