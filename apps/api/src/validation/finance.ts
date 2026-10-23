import { z } from "zod";

const moneyAmount = z.string()
  .regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/, "Use a positive amount with up to two decimal places.")
  .refine((amount) => /[1-9]/.test(amount), "Amount must be greater than zero.")
  .transform((amount) => {
    const decimalIndex = amount.indexOf(".");
    const whole = decimalIndex === -1 ? amount : amount.slice(0, decimalIndex);
    const fraction = decimalIndex === -1 ? "" : amount.slice(decimalIndex + 1);
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });

const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Provide a three-letter uppercase currency code.");

export const financeEncounterUuidSchema = z.string().uuid();
export const financeInvoiceUuidSchema = z.string().uuid();
export const financeFacilityIdSchema = z.coerce.number().int().positive().safe();
export const financeIdempotencyKeySchema = z.string().uuid();

export const financeChargeSchema = z.object({
  chargeCode: z.string().trim().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),
  description: z.string().trim().min(1).max(190),
  amount: moneyAmount,
  currencyCode,
}).strict();

export const financeInvoiceSchema = z.object({
  currencyCode,
}).strict();

export const financeAdjustmentSchema = z.object({
  adjustmentType: z.enum(["debit", "credit"]),
  amount: moneyAmount,
  reason: z.string().trim().min(10).max(500),
}).strict();

export type FinanceCharge = z.infer<typeof financeChargeSchema>;
export type FinanceInvoice = z.infer<typeof financeInvoiceSchema>;
export type FinanceAdjustment = z.infer<typeof financeAdjustmentSchema>;
