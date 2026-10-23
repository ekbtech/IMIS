import { z } from "zod";

export const diagnosticFacilityIdSchema = z.coerce.number().int().positive().safe();
export const diagnosticEncounterUuidSchema = z.string().uuid();
export const diagnosticOrderUuidSchema = z.string().uuid();
export const diagnosticServiceUuidSchema = z.string().uuid();
export const diagnosticIdempotencyKeySchema = z.string().uuid();

export const diagnosticOrderSchema = z.object({
  serviceId: diagnosticServiceUuidSchema,
}).strict();

export type DiagnosticOrder = z.infer<typeof diagnosticOrderSchema>;
