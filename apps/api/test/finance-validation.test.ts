import { describe, expect, it } from "vitest";
import {
  financeAdjustmentSchema,
  financeChargeSchema,
  financeIdempotencyKeySchema,
  financeInvoiceSchema,
} from "../src/validation/finance.js";

describe("disabled payer-neutral finance validation", () => {
  it("accepts bounded manual charges and three-letter currency codes", () => {
    const parsedCharge = financeChargeSchema.safeParse({
      chargeCode: "LOCAL.SERVICE-01",
      description: "Approved synthetic service label",
      amount: "1250.5",
      currencyCode: "KES",
    });
    expect(parsedCharge.success).toBe(true);
    if (parsedCharge.success) expect(parsedCharge.data.amount).toBe("1250.50");
    expect(financeInvoiceSchema.safeParse({ currencyCode: "USD" }).success).toBe(true);
  });

  it("rejects invalid money precision, currency, charge codes, and extra fields", () => {
    const charge = {
      chargeCode: "SERVICE",
      description: "Synthetic service",
      currencyCode: "KES",
    };
    expect(financeChargeSchema.safeParse({ ...charge, amount: "1.999" }).success).toBe(false);
    expect(financeChargeSchema.safeParse({ ...charge, amount: "-1" }).success).toBe(false);
    expect(financeChargeSchema.safeParse({ ...charge, amount: "0.00" }).success).toBe(false);
    expect(financeChargeSchema.safeParse({ ...charge, amount: "1.00", currencyCode: "kes" }).success).toBe(false);
    expect(financeChargeSchema.safeParse({ ...charge, amount: "1.00", chargeCode: "BAD CODE" }).success).toBe(false);
    expect(financeChargeSchema.safeParse({
      ...charge,
      amount: "1.00",
      tariffId: "invented",
    }).success).toBe(false);
  });

  it("requires a reasoned debit or credit adjustment and UUID retries", () => {
    expect(financeAdjustmentSchema.safeParse({
      adjustmentType: "credit",
      amount: "10.00",
      reason: "Approved correction to the synthetic invoice.",
    }).success).toBe(true);
    expect(financeAdjustmentSchema.safeParse({
      adjustmentType: "refund",
      amount: "10.00",
      reason: "Correction",
    }).success).toBe(false);
    expect(financeIdempotencyKeySchema.safeParse("d9428888-122b-4e09-a6f7-6c8f8a4a9d01").success).toBe(true);
    expect(financeIdempotencyKeySchema.safeParse("retry").success).toBe(false);
  });
});
