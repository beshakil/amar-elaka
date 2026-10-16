import type { FraudFlag } from './dto/agents.dto';

// settings-exempt: the Earth's mean radius in metres, a constant of the haversine formula.
const EARTH_RADIUS_M = 6_371_000;
// settings-exempt: unit conversion
const MS_PER_SECOND = 1000;
// settings-exempt: unit conversion
const SECONDS_PER_HOUR = 3600;
// settings-exempt: unit conversion
const METRES_PER_KM = 1000;
// settings-exempt: unit conversion
const SECONDS_PER_MINUTE = 60;
// settings-exempt: degrees in half a turn (π radians), a unit conversion.
const DEGREES_PER_PI = 180;
// settings-exempt: the haversine formula's half angles.
const HALF = 0.5;

export interface Point {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres. */
export function distanceM(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / DEGREES_PER_PI;
  const sq = (x: number) => x * x;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    sq(Math.sin(dLat * HALF)) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * sq(Math.sin(dLng * HALF));
  return (EARTH_RADIUS_M * Math.asin(Math.sqrt(h))) / HALF;
}

export interface FraudSettings {
  photoFixMaxM: number;
  photoAgeMaxMinutes: number;
  maxSpeedKmh: number;
  minSecondsBetween: number;
}

export interface CaptureFacts {
  capturedAt: Date;
  location: Point;
  photo: { location: Point | null; takenAt: Date | null } | null;
  /** The agent's captures nearest in time, before and after (a queue syncs out of order). */
  neighbours: readonly { capturedAt: Date; location: Point }[];
  /** Other submissions in the area with the same photo. */
  reusedPhotos: number;
  phoneFailed: boolean;
}

/**
 * The anti-fraud signals of one capture (ADR 066): flags for a reviewer,
 * never an automatic rejection. Agents are paid per shop, so each names what
 * a cheat would have to fake.
 */
export function fraudFlags(
  facts: CaptureFacts,
  settings: FraudSettings,
): { flags: FraudFlag[]; detail: Record<string, unknown> } {
  const flags = new Set<FraudFlag>();
  const detail: Record<string, unknown> = {};

  // The shutter's fix vs the save's: a photo taken elsewhere, or long before.
  const photo = facts.photo;
  if (!photo || !photo.location || !photo.takenAt) {
    flags.add('gps_photo_mismatch');
    detail.photoFix = 'missing';
  } else {
    const apart = Math.round(distanceM(photo.location, facts.location));
    const minutesBefore =
      (facts.capturedAt.getTime() - photo.takenAt.getTime()) / MS_PER_SECOND / SECONDS_PER_MINUTE;
    if (
      apart > settings.photoFixMaxM ||
      minutesBefore > settings.photoAgeMaxMinutes ||
      minutesBefore < 0
    ) {
      flags.add('gps_photo_mismatch');
      detail.photoFix = { metresApart: apart, minutesBefore: Math.round(minutesBefore) };
    }
  }

  for (const n of facts.neighbours) {
    const seconds = Math.abs(facts.capturedAt.getTime() - n.capturedAt.getTime()) / MS_PER_SECOND;
    const metres = distanceM(n.location, facts.location);
    if (seconds < settings.minSecondsBetween) {
      flags.add('rapid_fire');
      detail.rapidFire = { seconds: Math.round(seconds) };
    }
    // Speed needed to get from the neighbour to here (any distance in no time is impossible).
    const kmh = seconds === 0 ? Infinity : metres / METRES_PER_KM / (seconds / SECONDS_PER_HOUR);
    if (kmh > settings.maxSpeedKmh && metres > settings.photoFixMaxM) {
      flags.add('impossible_travel');
      detail.travel = { metres: Math.round(metres), seconds: Math.round(seconds) };
    }
  }

  if (facts.reusedPhotos > 0) {
    flags.add('duplicate_photo');
    detail.duplicatePhoto = { matches: facts.reusedPhotos };
  }
  if (facts.phoneFailed) flags.add('phone_otp_failed');

  return { flags: [...flags].sort(), detail };
}
