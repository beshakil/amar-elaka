/**
 * Distances on the WGS84 ellipsoid, in the app (the database uses PostGIS
 * geography, which agrees with this to the millimetre — test/locations.db-spec.ts).
 * Used where no query runs: ordering geocoder results by distance, checks.
 *
 * Vincenty's inverse formula: accurate to well under a millimetre for any two
 * points in Bangladesh. It can fail to converge only for nearly antipodal
 * points, where this falls back to a spherical (haversine) distance.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

// WGS84 constants — facts of the reference ellipsoid, not tunable values.
const A = 6_378_137; // settings-exempt: WGS84 semi-major axis (m)
const F = 1 / 298.257223563; // settings-exempt: WGS84 flattening
const B = (1 - F) * A;
const MEAN_RADIUS = 6_371_008.8; // settings-exempt: IUGG mean Earth radius (m), fallback only
const MAX_ITERATIONS = 200; // settings-exempt: numerical method bound
const CONVERGENCE = 1e-12; // settings-exempt: numerical method bound

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance on a sphere of the mean Earth radius (error up to ~0.5%). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * MEAN_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Geodesic distance in metres between two WGS84 points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  if (a.lat === b.lat && a.lng === b.lng) return 0;
  const L = rad(b.lng - a.lng);
  const U1 = Math.atan((1 - F) * Math.tan(rad(a.lat)));
  const U2 = Math.atan((1 - F) * Math.tan(rad(b.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0;
    const cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    const sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    const cos2Alpha = 1 - sinAlpha ** 2;
    // On the equator cos2Alpha is 0 and the term below is defined as 0.
    const cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < CONVERGENCE) {
      const u2 = (cos2Alpha * (A ** 2 - B ** 2)) / B ** 2;
      const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
      const deltaSigma =
        bigB *
        sinSigma *
        (cos2SigmaM +
          (bigB / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
              (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
      return B * bigA * (sigma - deltaSigma);
    }
  }
  return haversineMeters(a, b);
}

/** A viewport box, validated: min < max, inside WGS84 bounds. */
export interface BoundingBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}
