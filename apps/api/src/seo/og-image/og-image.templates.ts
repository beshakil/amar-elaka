/**
 * rule 6: no hardcoded user-facing strings in application code — this is the
 * one place the text on a listing's share image is worded (Bengali, the
 * platform default; the image is the same for every viewer).
 */
export const OG_TEXT = {
  brand: 'আমার এলাকা',
  sold: 'বিক্রি হয়ে গেছে',
  free: 'ফ্রি',
  priceOnRequest: 'দাম জানতে যোগাযোগ করুন',
  negotiable: 'আলোচনা সাপেক্ষে',
  perMonth: '/মাস',
} as const;

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
// settings-exempt: South Asian digit grouping (thousands, then pairs) is a fact of the notation
const THOUSANDS = 3;

/** "65000.00" → "৳ ৬৫,০০০": South Asian grouping, Bengali digits, paisa only when non-zero. */
export function bengaliTaka(money: string): string {
  const [whole = '0', fraction = ''] = money.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  const grouped =
    digits.length <= THOUSANDS
      ? digits
      : `${digits.slice(0, -THOUSANDS).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-THOUSANDS)}`;
  const text = /^0*$/.test(fraction) ? grouped : `${grouped}.${fraction}`;
  return `৳ ${text.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)]!)}`;
}

/** The price line as a listing card says it. */
export function ogPriceLine(price: string | null, priceType: string | null): string {
  if (priceType === 'free') return OG_TEXT.free;
  if (price === null) return OG_TEXT.priceOnRequest;
  const amount = bengaliTaka(price);
  if (priceType === 'per_month') return `${amount}${OG_TEXT.perMonth}`;
  if (priceType === 'negotiable') return `${amount} (${OG_TEXT.negotiable})`;
  return amount;
}

/** Pango markup is XML: escape what a seller's title may contain. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
