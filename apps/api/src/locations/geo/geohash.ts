/**
 * Geohash (Niemeyer, base32): a point's cell at `precision` characters. Each
 * character halves the cell five times, alternating longitude and latitude,
 * so nearby points share a prefix. Used as the reverse-geocode cache key
 * (reverse_geocode_cache_precision, ADR 044): length 7 is a cell of about
 * 153 m × 153 m — roughly a block — so pins dropped in the same block reuse
 * one paid answer.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS_PER_CHAR = 5;

export function geohash(lat: number, lng: number, precision: number): string {
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let hash = '';
  let bits = 0;
  let value = 0;
  let evenBit = true; // longitude first
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) {
        value = value * 2 + 1;
        minLng = mid;
      } else {
        value *= 2;
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        value = value * 2 + 1;
        minLat = mid;
      } else {
        value *= 2;
        maxLat = mid;
      }
    }
    evenBit = !evenBit;
    if (++bits === BITS_PER_CHAR) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}
