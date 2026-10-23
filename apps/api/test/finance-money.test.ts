import { describe, expect, it } from "vitest";
import { sumMoneyAmounts } from "../src/finance/money.js";

describe("exact finance amount arithmetic", () => {
  it("sums decimal strings without floating-point rounding", () => {
    expect(sumMoneyAmounts(["0.10", "0.20", "99.99"])).toBe("100.29");
  });

  it("supports large amounts and an empty set", () => {
    expect(sumMoneyAmounts(["99999999999.99", "0.01"])).toBe("100000000000.00");
    expect(sumMoneyAmounts([])).toBe("0.00");
  });

  it("rejects malformed stored amounts instead of silently coercing them", () => {
    expect(() => sumMoneyAmounts(["1.001"])).toThrow("not a valid decimal");
    expect(() => sumMoneyAmounts(["not-money"])).toThrow("not a valid decimal");
  });
});
