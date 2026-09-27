import { toPoisha } from '../categories/field-schema/money';

/**
 * True when a post's price went down: both are money strings ("12500.00"),
 * compared as integer poisha, never as floats (CLAUDE.md rule 2). A price
 * that appears or disappears is not a drop.
 */
export function isPriceDrop(from: string | null, to: string | null): boolean {
  if (from === null || to === null) return false;
  return toPoisha(to) < toPoisha(from);
}
