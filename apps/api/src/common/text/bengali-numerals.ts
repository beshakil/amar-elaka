const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
// settings-exempt: South Asian digit grouping (thousands, then pairs) is a fact of the notation
const THOUSANDS = 3;

/** Every ASCII digit in `text` as a Bengali digit. */
export function bengaliDigits(text: string): string {
  return text.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)]!);
}

/** "1240" → "1,240", "1234567" → "12,34,567": South Asian grouping, ASCII digits. */
export function groupSouthAsian(wholeDigits: string): string {
  const digits = wholeDigits.replace(/^0+(?=\d)/, '');
  return digits.length <= THOUSANDS
    ? digits
    : `${digits.slice(0, -THOUSANDS).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-THOUSANDS)}`;
}

/** 1240 → "১,২৪০". */
export function bengaliNumber(n: number): string {
  return bengaliDigits(groupSouthAsian(String(Math.trunc(Math.abs(n)))));
}
