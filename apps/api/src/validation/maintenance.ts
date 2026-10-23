import { z } from "zod";

export const maintenanceFacilityIdSchema = z.coerce.number().int().positive().safe();
export const maintenanceRequestIdSchema = z.string().uuid();
export const maintenanceIdempotencyKeySchema = z.string().uuid();

export const maintenanceRequestSchema = z.object({
  reportingDepartmentId: z.coerce.number().int().positive().safe(),
  assetTag: z.string().trim().min(1).max(100),
  location: z.string().trim().min(2).max(250),
  issue: z.string().trim().min(10).max(1000),
}).strict();

export const maintenanceTransitionSchema = z.object({
  action: z.enum(["acknowledge", "start", "complete", "cancel"]),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();
