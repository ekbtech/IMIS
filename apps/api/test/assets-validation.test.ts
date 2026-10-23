import { describe, expect, it } from "vitest";
import { assetEntrySchema, assetUpdateSchema } from "../src/validation/assets.js";

const validAsset = {
  departmentId: 7,
  assetTag: "EQ-OPD-001",
  name: "Examination lamp",
  category: "Clinical equipment",
  location: "Outpatient room 2",
};

describe("equipment asset validation", () => {
  it("accepts valid equipment records and defaults optional descriptive fields", () => {
    expect(assetEntrySchema.parse(validAsset)).toMatchObject({
      ...validAsset,
      manufacturer: "",
      model: "",
      serialNumber: "",
    });
  });

  it("rejects incomplete values and unsupported data", () => {
    expect(assetEntrySchema.safeParse({ ...validAsset, assetTag: " " }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...validAsset, location: "A" }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...validAsset, depreciationRate: 5 }).success).toBe(false);
  });

  it("does not permit asset tag changes through the update schema", () => {
    expect(assetUpdateSchema.safeParse({
      departmentId: 7,
      name: "Examination lamp",
      category: "Clinical equipment",
      location: "Outpatient room 2",
      assetTag: "EQ-OPD-002",
    }).success).toBe(false);
  });
});
