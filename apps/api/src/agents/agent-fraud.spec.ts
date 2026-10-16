import { distanceM, fraudFlags, type FraudSettings } from './agent-fraud';
import { sumMoney } from './agent-work.service';

const SETTINGS: FraudSettings = {
  photoFixMaxM: 150,
  photoAgeMaxMinutes: 30,
  maxSpeedKmh: 80,
  minSecondsBetween: 40,
};
const AT = new Date('2026-10-16T05:00:00Z');
const HERE = { lat: 23.8103, lng: 90.4125 };
const clean = {
  capturedAt: AT,
  location: HERE,
  photo: { location: HERE, takenAt: new Date(AT.getTime() - 60_000) },
  neighbours: [],
  reusedPhotos: 0,
  phoneFailed: false,
};

describe('field agent anti-fraud signals (ADR 066)', () => {
  it('measures distances on the globe', () => {
    // ~1.11 km per 0.01° of latitude.
    expect(Math.round(distanceM(HERE, { lat: 23.8203, lng: 90.4125 }))).toBe(1112);
  });

  it('flags nothing for an honest capture', () => {
    expect(fraudFlags(clean, SETTINGS).flags).toEqual([]);
  });

  it('flags a photo shot elsewhere, long before, or with no fix', () => {
    const far = {
      ...clean,
      photo: { location: { lat: 23.8203, lng: 90.4125 }, takenAt: clean.photo.takenAt },
    };
    expect(fraudFlags(far, SETTINGS).flags).toEqual(['gps_photo_mismatch']);
    const old = {
      ...clean,
      photo: { location: HERE, takenAt: new Date(AT.getTime() - 2 * 3_600_000) },
    };
    expect(fraudFlags(old, SETTINGS).flags).toEqual(['gps_photo_mismatch']);
    expect(fraudFlags({ ...clean, photo: null }, SETTINGS).flags).toEqual(['gps_photo_mismatch']);
  });

  it('flags captures seconds apart, and travel no one could make', () => {
    const quick = {
      ...clean,
      neighbours: [{ capturedAt: new Date(AT.getTime() - 10_000), location: HERE }],
    };
    expect(fraudFlags(quick, SETTINGS).flags).toEqual(['rapid_fire']);
    // 10 km in 2 minutes = 300 km/h.
    const flying = {
      ...clean,
      neighbours: [
        { capturedAt: new Date(AT.getTime() - 120_000), location: { lat: 23.9003, lng: 90.4125 } },
      ],
    };
    expect(fraudFlags(flying, SETTINGS).flags).toEqual(['impossible_travel']);
    // Next door a minute later is fine.
    const nextDoor = {
      ...clean,
      neighbours: [
        { capturedAt: new Date(AT.getTime() - 60_000), location: { lat: 23.8104, lng: 90.4125 } },
      ],
    };
    expect(fraudFlags(nextDoor, SETTINGS).flags).toEqual([]);
  });

  it('flags a reused photo and a failed phone check', () => {
    expect(fraudFlags({ ...clean, reusedPhotos: 2, phoneFailed: true }, SETTINGS).flags).toEqual([
      'duplicate_photo',
      'phone_otp_failed',
    ]);
  });
});

describe('sumMoney', () => {
  it('adds taka exactly, in poisha', () => {
    expect(sumMoney(['20.00', '0.10', '0.20', '15.5'])).toBe('35.80');
    expect(sumMoney([])).toBe('0.00');
  });
});
