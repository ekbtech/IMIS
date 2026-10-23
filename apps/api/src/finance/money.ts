function moneyMinorUnits(amount: string): bigint {
  const [whole, fraction] = amount.split(".");
  if (!whole || !/^\d+$/.test(whole) || (fraction !== undefined && !/^\d{1,2}$/.test(fraction))) {
    throw new Error("A stored finance amount is not a valid decimal value.");
  }
  return BigInt(whole) * 100n + BigInt((fraction ?? "").padEnd(2, "0"));
}

export function sumMoneyAmounts(amounts: readonly string[]): string {
  const minorUnits = amounts.reduce((sum, amount) => sum + moneyMinorUnits(amount), 0n);
  return `${minorUnits / 100n}.${String(minorUnits % 100n).padStart(2, "0")}`;
}
