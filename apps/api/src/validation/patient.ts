import { z } from "zod";

const dateOfBirthSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value &&
      date.getTime() <= Date.now();
  }, "Enter a valid date of birth that is not in the future.");

const identityFields = {
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().min(1).max(100),
  dateOfBirth: dateOfBirthSchema,
  sexAtRegistration: z.enum(["female", "male", "intersex", "unknown", "not_recorded"]),
};

export const patientIdentitySchema = z.object(identityFields);

export const duplicateCandidatesSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  ...identityFields,
});

export const patientRegistrationSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  ...identityFields,
  duplicateReviews: z.array(z.object({
    candidatePatientId: z.coerce.number().int().positive(),
    disposition: z.enum(["different_person", "same_person"]),
    reason: z.string().trim().min(10).max(500),
  })).max(20).optional(),
});

export const patientSearchSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  recordNumber: z.string().trim().min(1).max(40).optional(),
  givenName: z.string().trim().min(1).max(100).optional(),
  familyName: z.string().trim().min(1).max(100).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
}).refine((value) =>
  Boolean(value.recordNumber) ||
  (Boolean(value.givenName && value.familyName) && (!value.dateOfBirth || Boolean(value.givenName))),
  "Search by record number, or by both given and family names.",
);

export type PatientIdentity = z.infer<typeof patientIdentitySchema>;
