/**
 * Location hierarchy: Bangladesh > Division > District > Thana/Upazila >
 * Area. Two branches — Mirpur (urban Dhaka thana) and Trishal (rural
 * Mymensingh upazila) — sharing the country/division ancestor is not
 * possible here since they're different divisions, so the tree is:
 *
 *   Bangladesh
 *   ├─ Dhaka Division ─ Dhaka District ─ Mirpur Thana ─ Mirpur-10, Mirpur-11
 *   └─ Mymensingh Division ─ Mymensingh District ─ Trishal Upazila ─ Trishal Sadar, Amirabari
 *
 * Coordinates are real-ish (approximately correct location and extent) —
 * simple bounding-box rectangles, not authoritative GADM/HDX boundaries
 * (§13.27 notes real boundary data as a later import job).
 */

export interface GeoAreaDef {
  slug: string;
  parentSlug: string | null;
  admLevel: number;
  levelCode: string;
  nameEn: string;
  nameBn?: string;
  bbsCode: string | null;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
}

export const GEO_AREAS: GeoAreaDef[] = [
  {
    slug: 'bangladesh',
    parentSlug: null,
    admLevel: 0,
    levelCode: 'country',
    nameEn: 'Bangladesh',
    nameBn: 'বাংলাদেশ',
    bbsCode: null,
    bbox: [88.0, 20.5, 92.7, 26.7],
  },

  // ---- Mirpur branch (urban) ----------------------------------------------
  {
    slug: 'dhaka-division',
    parentSlug: 'bangladesh',
    admLevel: 1,
    levelCode: 'division',
    nameEn: 'Dhaka Division',
    nameBn: 'ঢাকা বিভাগ',
    bbsCode: 'seed-adm1-30',
    bbox: [88.4, 23.0, 91.2, 24.9],
  },
  {
    slug: 'dhaka-district',
    parentSlug: 'dhaka-division',
    admLevel: 2,
    levelCode: 'district',
    nameEn: 'Dhaka District',
    nameBn: 'ঢাকা জেলা',
    bbsCode: 'seed-adm2-26',
    bbox: [90.25, 23.6, 90.55, 24.05],
  },
  {
    slug: 'mirpur-thana',
    parentSlug: 'dhaka-district',
    admLevel: 3,
    levelCode: 'metro_thana',
    nameEn: 'Mirpur Thana',
    nameBn: 'মিরপুর থানা',
    bbsCode: 'seed-adm3-mirpur',
    bbox: [90.34, 23.79, 90.39, 23.83],
  },
  {
    slug: 'mirpur-10',
    parentSlug: 'mirpur-thana',
    admLevel: 4,
    levelCode: 'ward',
    nameEn: 'Mirpur-10',
    nameBn: 'মিরপুর-১০',
    bbsCode: 'seed-adm4-mirpur-10',
    bbox: [90.36, 23.8, 90.372, 23.812],
  },
  {
    slug: 'mirpur-11',
    parentSlug: 'mirpur-thana',
    admLevel: 4,
    levelCode: 'ward',
    nameEn: 'Mirpur-11',
    nameBn: 'মিরপুর-১১',
    bbsCode: 'seed-adm4-mirpur-11',
    bbox: [90.355, 23.815, 90.368, 23.828],
  },

  // ---- Trishal branch (rural) -----------------------------------------------
  {
    slug: 'mymensingh-division',
    parentSlug: 'bangladesh',
    admLevel: 1,
    levelCode: 'division',
    nameEn: 'Mymensingh Division',
    nameBn: 'ময়মনসিংহ বিভাগ',
    bbsCode: 'seed-adm1-45',
    bbox: [89.7, 24.3, 91.1, 25.4],
  },
  {
    slug: 'mymensingh-district',
    parentSlug: 'mymensingh-division',
    admLevel: 2,
    levelCode: 'district',
    nameEn: 'Mymensingh District',
    nameBn: 'ময়মনসিংহ জেলা',
    bbsCode: 'seed-adm2-39',
    bbox: [90.2, 24.5, 90.7, 25.1],
  },
  {
    slug: 'trishal-upazila',
    parentSlug: 'mymensingh-district',
    admLevel: 3,
    levelCode: 'upazila',
    nameEn: 'Trishal Upazila',
    nameBn: 'ত্রিশাল উপজেলা',
    bbsCode: 'seed-adm3-trishal',
    bbox: [90.32, 24.53, 90.48, 24.65],
  },
  {
    slug: 'trishal-sadar',
    parentSlug: 'trishal-upazila',
    admLevel: 4,
    levelCode: 'union',
    nameEn: 'Trishal Sadar Union',
    nameBn: 'ত্রিশাল সদর ইউনিয়ন',
    bbsCode: 'seed-adm4-trishal-sadar',
    bbox: [90.38, 24.56, 90.42, 24.6],
  },
  {
    slug: 'amirabari',
    parentSlug: 'trishal-upazila',
    admLevel: 4,
    levelCode: 'union',
    nameEn: 'Amirabari Union',
    nameBn: 'আমিরাবাড়ী ইউনিয়ন',
    bbsCode: 'seed-adm4-amirabari',
    bbox: [90.34, 24.58, 90.38, 24.62],
  },
];

export function centroidOf(bbox: [number, number, number, number]): [number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

/** WKT MultiPolygon for a rectangular boundary from a bbox (matches geo_areas.boundary's type). */
export function bboxMultiPolygonWkt(bbox: [number, number, number, number]): string {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const ring = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
    .map(([lon, lat]) => `${lon} ${lat}`)
    .join(', ');
  return `MULTIPOLYGON(((${ring})))`;
}

/** A random point inside a bbox (posts/places/stores coordinates). */
export function randomPointIn(
  bbox: [number, number, number, number],
  rand: () => number,
): [number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return [minLon + rand() * (maxLon - minLon), minLat + rand() * (maxLat - minLat)];
}
