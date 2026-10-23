import { z } from "zod";

export const assetFacilityIdSchema = z.coerce.number().int().positive().safe();
export const assetUuidSchema = z.string().uuid();

export const assetEntrySchema = z.object({
  departmentId: z.coerce.number().int().positive().safe(),
  assetTag: z.string().trim().min(1).max(100),
  name: z.string().trim().min(2).max(190),
  category: z.string().trim().min(2).max(100),
  manufacturer: z.string().trim().max(120).default(""),
  model: z.string().trim().max(120).default(""),
  serialNumber: z.string().trim().max(100).default(""),
  location: z.string().trim().min(2).max(250),
}).strict();

export const assetUpdateSchema = assetEntrySchema.omit({ assetTag: true });
