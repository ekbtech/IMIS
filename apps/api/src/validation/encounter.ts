import { z } from "zod";

export const encounterRegistrationSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  patientId: z.coerce.number().int().positive(),
  encounterType: z.enum(["outpatient", "emergency"]),
});

export const encounterQueueSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
});

export const idempotencyKeySchema = z.string().uuid();

export type EncounterRegistration = z.infer<typeof encounterRegistrationSchema>;
