/**
 * Geohash (Niemeyer, public domain algorithm): the first-page cache cell of
 * the feed. The feed's origin snaps to the cell centre, so every viewer in
 * one cell shares one cached page and one scoring origin.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
// settings-exempt: the geohash format itself — 5 bits per base32 character
const BITS_PER_CHAR = 5;
// settings-exempt: coordinate system bounds (degrees)
const MAX_LAT = 90;
// settings-exempt: coordinate system bounds (degrees)
const MAX_LNG = 180;
// settings-exempt: bisection midpoint
const HALF = 2;

interface Range {
  min: number;
  max: number;
}

export function geohashEncode(lat: number, lng: number, precision: number): string {
  const latRange: Range = { min: -MAX_LAT, max: MAX_LAT };
  const lngRange: Range = { min: -MAX_LNG, max: MAX_LNG };
  let hash = '';
  let bits = 0;
  let value = 0;
  let evenBit = true;
  while (hash.length < precision) {
    const range = evenBit ? lngRange : latRange;
    const coordinate = evenBit ? lng : lat;
    const mid = (range.min + range.max) / HALF;
    value <<= 1;
    if (coordinate >= mid) {
      value |= 1;
      range.min = mid;
    } else {
      range.max = mid;
    }
    evenBit = !evenBit;
    bits += 1;
    if (bits === BITS_PER_CHAR) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/** Centre of a geohash cell. */
export function geohashCenter(hash: string): { lat: number; lng: number } {
  const latRange: Range = { min: -MAX_LAT, max: MAX_LAT };
  const lngRange: Range = { min: -MAX_LNG, max: MAX_LNG };
  let evenBit = true;
  for (const char of hash) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError(`not a geohash character: ${char}`);
    for (let bit = BITS_PER_CHAR - 1; bit >= 0; bit -= 1) {
      const range = evenBit ? lngRange : latRange;
      const mid = (range.min + range.max) / HALF;
      if ((index >> bit) & 1) range.min = mid;
      else range.max = mid;
      evenBit = !evenBit;
    }
  }
  return {
    lat: (latRange.min + latRange.max) / HALF,
    lng: (lngRange.min + lngRange.max) / HALF,
  };
}
