import { distanceMeters, haversineMeters } from './geodesic';

/**
 * Known Dhaka coordinates. Expected distances are from an independent
 * Vincenty (WGS84) computation and agree with PostGIS
 * ST_Distance(geography) to the millimetre (test/locations.db-spec.ts).
 */
const DHAKA = {
  parliament: { lat: 23.7625, lng: 90.3783 }, // Jatiya Sangsad Bhaban
  airport: { lat: 23.8433, lng: 90.3978 }, // Hazrat Shahjalal International
  motijheel: { lat: 23.7302, lng: 90.4172 }, // Shapla Chattar
  mirpur10: { lat: 23.8069, lng: 90.3687 }, // Mirpur 10 roundabout
  sadarghat: { lat: 23.7059, lng: 90.4086 }, // Sadarghat launch terminal
  trishal: { lat: 24.581, lng: 90.3939 }, // Trishal upazila town
};

describe('distanceMeters (WGS84 geodesic)', () => {
  it.each([
    ['parliament', 'airport', 9167.01],
    ['motijheel', 'mirpur10', 9828.731],
    ['sadarghat', 'airport', 15257.498],
    ['mirpur10', 'trishal', 85778.338],
  ] as const)('%s → %s = %d m (to the millimetre)', (a, b, expected) => {
    expect(distanceMeters(DHAKA[a], DHAKA[b])).toBeCloseTo(expected, 3);
  });

  it('is symmetric and zero for the same point', () => {
    expect(distanceMeters(DHAKA.airport, DHAKA.parliament)).toBeCloseTo(
      distanceMeters(DHAKA.parliament, DHAKA.airport),
      6,
    );
    expect(distanceMeters(DHAKA.parliament, DHAKA.parliament)).toBe(0);
  });

  it('is exact at street scale too (0.0009° north of Mirpur 10 ≈ 99.68 m)', () => {
    const north = { lat: DHAKA.mirpur10.lat + 0.0009, lng: DHAKA.mirpur10.lng };
    expect(distanceMeters(DHAKA.mirpur10, north)).toBeCloseTo(99.6799, 3);
  });

  it('agrees with the spherical approximation to within 0.5%', () => {
    const exact = distanceMeters(DHAKA.mirpur10, DHAKA.trishal);
    expect(Math.abs(haversineMeters(DHAKA.mirpur10, DHAKA.trishal) - exact) / exact).toBeLessThan(
      0.005,
    );
  });
});
