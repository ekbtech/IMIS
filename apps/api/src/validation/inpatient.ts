import { z } from "zod";

export const inpatientFacilityIdSchema = z.coerce.number().int().positive().safe();
export const inpatientEncounterUuidSchema = z.string().uuid();
export const inpatientAdmissionUuidSchema = z.string().uuid();
export const inpatientBedUuidSchema = z.string().uuid();
export const inpatientIdempotencyKeySchema = z.string().uuid();

export const inpatientAdmissionSchema = z.object({}).strict();
export const inpatientBedAssignmentSchema = z.object({
  bedId: inpatientBedUuidSchema,
}).strict();
export const inpatientDischargeSchema = z.object({}).strict();

export type InpatientBedAssignment = z.infer<typeof inpatientBedAssignmentSchema>;
