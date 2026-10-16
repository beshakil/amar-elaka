import type { DirectoryKind } from './dto/info-engine.dto';

/**
 * The info engine's shared rules (ADR 065), pure so they are tested alone.
 */

// settings-exempt: unit conversion (the windows themselves are settings)
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * THE stale rule: an item last confirmed `staleDays` ago or more "may be out
 * of date". Never confirmed at all is stale.
 */
export function isStale(confirmedAt: Date | string | null, staleDays: number, now: Date): boolean {
  if (confirmedAt === null) return true;
  const at = typeof confirmedAt === 'string' ? new Date(confirmedAt) : confirmedAt;
  return now.getTime() - at.getTime() >= staleDays * MS_PER_DAY;
}

/** The latest of several confirmation moments (verified, updated…), or null. */
export function latest(...moments: (Date | string | null | undefined)[]): Date | null {
  const times = moments
    .filter((m): m is Date | string => m !== null && m !== undefined)
    .map((m) => (typeof m === 'string' ? new Date(m) : m).getTime());
  return times.length === 0 ? null : new Date(Math.max(...times));
}

/**
 * The directory's kinds (ADR 065): places of these categories, told apart
 * by one select field of the category (hospital vs clinic vs diagnostic).
 */
export const DIRECTORY: Record<DirectoryKind, { categories: string[]; fieldKey: string | null }> = {
  health: { categories: ['hospital-doctor-chambers'], fieldKey: 'facility_type' },
  pharmacy: { categories: ['pharmacy'], fieldKey: 'pharmacy_type' },
  education: { categories: ['schools-colleges'], fieldKey: 'institution_type' },
};

// settings-exempt: poisha per taka — numeric(12,2) keeps two decimals
const MONEY_DECIMALS = 2;

/** Money as stored (§0.2): "100" → "100.00", "7.5" → "7.50" — string work, never a float. */
export function normalizeMoney(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(MONEY_DECIMALS, '0').slice(0, MONEY_DECIMALS)}`;
}

/** A keyset cursor `<distance>_<id>`. */
export function encodeCursor(distance: number, id: string): string {
  return `${distance}_${id}`;
}

export function decodeCursor(cursor: string): { distance: number; id: string } {
  const at = cursor.indexOf('_');
  return { distance: Number(cursor.slice(0, at)), id: cursor.slice(at + 1) };
}

/** An outage's badge: happening now, or still to come. */
export function outagePhase(
  startsAt: Date,
  endsAt: Date,
  now: Date,
): 'ongoing' | 'upcoming' | 'ended' {
  if (endsAt <= now) return 'ended';
  return startsAt <= now ? 'ongoing' : 'upcoming';
}
