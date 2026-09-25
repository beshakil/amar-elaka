/** A money value as stored in JSON: at most `numeric(12,2)`, two decimals (schema.md §0.2). */
export const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;

/** Exact integer poisha, so money is compared without floating point. */
export function toPoisha(money: string): bigint {
  return BigInt(money.replace('.', ''));
}
