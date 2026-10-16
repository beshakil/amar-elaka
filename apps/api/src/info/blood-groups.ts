import type { BloodGroup } from './dto/info.dto';

/**
 * The ABO/Rh symbol of each blood_groups code — the same in Bengali and
 * English ("B+"), so notification params carry the symbol, not a label.
 */
export const BLOOD_GROUP_SYMBOL: Record<BloodGroup, string> = {
  a_pos: 'A+',
  a_neg: 'A-',
  b_pos: 'B+',
  b_neg: 'B-',
  ab_pos: 'AB+',
  ab_neg: 'AB-',
  o_pos: 'O+',
  o_neg: 'O-',
};

/** Where blood notifications open in the apps. */
export const BLOOD_DEEP_LINKS = {
  request: (id: string) => `/info/blood/requests/${id}`,
  myContacts: '/info/blood/me/contacts',
} as const;

/** Donor search cursor: `<distance>_<id>` — the keyset of blood_donors_near(). */
export function encodeDonorCursor(distance: number, id: string): string {
  return `${distance}_${id}`;
}

export function decodeDonorCursor(cursor: string): { distance: number; id: string } {
  const at = cursor.indexOf('_');
  return { distance: Number(cursor.slice(0, at)), id: cursor.slice(at + 1) };
}
