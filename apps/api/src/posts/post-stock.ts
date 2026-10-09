/** A store product's stock (lookup stock_statuses, 0053, ADR 057). */
export const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'on_order'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/**
 * What a post's stock reads as: a store's product without a recorded status
 * is in stock; a personal post has none.
 */
export function stockStatusOf(storeId: string | null, code: string | null): StockStatus | null {
  if (storeId === null) return null;
  return STOCK_STATUSES.find((s) => s === code) ?? 'in_stock';
}
