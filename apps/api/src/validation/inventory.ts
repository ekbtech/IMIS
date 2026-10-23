import { z } from "zod";

export const inventoryFacilityIdSchema = z.coerce.number().int().positive().safe();
export const inventoryDepartmentIdSchema = z.coerce.number().int().positive().safe();
export const inventoryItemIdSchema = z.coerce.number().int().positive().safe();
export const inventoryIdempotencyKeySchema = z.string().uuid();

export const inventoryItemSchema = z.object({
  itemCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u),
  name: z.string().trim().min(2).max(190),
  unitOfMeasure: z.string().trim().min(1).max(32),
}).strict();

export const inventoryMovementSchema = z.object({
  movementType: z.enum(["receipt", "issue"]),
  inventoryItemId: inventoryItemIdSchema,
  batchCode: z.string().trim().min(1).max(100),
  expiresOn: z.string().date().nullable().optional(),
  quantity: z.coerce.number().positive().finite().max(99999999999.999),
  reference: z.string().trim().min(2).max(120),
  issueToDepartmentId: inventoryDepartmentIdSchema.optional(),
}).strict().refine(
  (movement) => movement.movementType === "issue"
    ? movement.issueToDepartmentId !== undefined
    : movement.issueToDepartmentId === undefined,
  { message: "Choose a receiving department for an issue; receipts must not include one." },
);
