import { describe, expect, it } from "vitest";
import { inventoryItemSchema, inventoryMovementSchema } from "../src/validation/inventory.js";

describe("inventory validation", () => {
  it("accepts a valid catalogue item and batch receipt", () => {
    expect(inventoryItemSchema.safeParse({
      itemCode: "GLOVE-M",
      name: "Examination gloves medium",
      unitOfMeasure: "box",
    }).success).toBe(true);
    expect(inventoryMovementSchema.safeParse({
      movementType: "receipt",
      inventoryItemId: 1,
      batchCode: "BATCH-2035-01",
      expiresOn: "2035-12-31",
      quantity: 12.5,
      reference: "Delivery note DN-2035",
    }).success).toBe(true);
  });

  it("requires an issue destination and prohibits it for receipts", () => {
    const base = {
      inventoryItemId: 1,
      batchCode: "B-1",
      quantity: 2,
      reference: "Issue request 123",
    };
    expect(inventoryMovementSchema.safeParse({ ...base, movementType: "issue" }).success).toBe(false);
    expect(inventoryMovementSchema.safeParse({
      ...base,
      movementType: "issue",
      issueToDepartmentId: 4,
    }).success).toBe(true);
    expect(inventoryMovementSchema.safeParse({
      ...base,
      movementType: "receipt",
      issueToDepartmentId: 4,
    }).success).toBe(false);
  });

  it("rejects invalid codes, dates, quantities, and unexpected properties", () => {
    expect(inventoryItemSchema.safeParse({
      itemCode: "invalid code",
      name: "Supply item",
      unitOfMeasure: "each",
    }).success).toBe(false);
    expect(inventoryMovementSchema.safeParse({
      movementType: "receipt",
      inventoryItemId: 1,
      batchCode: "B-1",
      expiresOn: "2035-02-30",
      quantity: 1,
      reference: "Delivery 1",
    }).success).toBe(false);
    expect(inventoryMovementSchema.safeParse({
      movementType: "receipt",
      inventoryItemId: 1,
      batchCode: "B-1",
      quantity: 0,
      reference: "Delivery 1",
    }).success).toBe(false);
    expect(inventoryMovementSchema.safeParse({
      movementType: "receipt",
      inventoryItemId: 1,
      batchCode: "B-1",
      quantity: 1,
      reference: "Delivery 1",
      balance: 500,
    }).success).toBe(false);
  });
});
