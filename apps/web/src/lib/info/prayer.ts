/**
 * Prayer times calculated from coordinates — no API (ADR 065). The standard
 * astronomical method (the PrayTimes.org formulas): the sun's position for
 * the day, then each time from the sun's angle below the horizon. The Dart
 * twin is apps/mobile/lib/features/info/prayer/prayer_times.dart; both are
 * checked against the same vectors.
 *
 * Methods (Fajr angle, Isha angle or minutes after Maghrib):
 *   karachi 18° / 18° (Bangladesh's usual), mwl 18° / 17°, isna 15° / 15°,
 *   egypt 19.5° / 17.5°, umm_al_qura 18.5° / 90 min.
 */

export type PrayerMethod = 'karachi' | 'mwl' | 'isna' | 'egypt' | 'umm_al_qura';
export type AsrSchool = 'hanafi' | 'standard';
export type PrayerName = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
export const PRAYER_NAMES: readonly PrayerName[] = [
  'fajr',
  'sunrise',
  'dhuhr',
  'asr',
  'maghrib',
  'isha',
];

const METHODS: Record<
  PrayerMethod,
  { fajr: number; isha: { angle: number } | { minutes: number } }
> = {
  karachi: { fajr: 18, isha: { angle: 18 } },
  mwl: { fajr: 18, isha: { angle: 17 } },
  isna: { fajr: 15, isha: { angle: 15 } },
  egypt: { fajr: 19.5, isha: { angle: 17.5 } },
  umm_al_qura: { fajr: 18.5, isha: { minutes: 90 } },
};

// Astronomy constants (facts, not settings): refraction + the sun's radius.
const RISE_SET_ANGLE = 0.833;
const J2000 = 2451545.0;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const fix = (a: number, b: number) => {
  const r = a - b * Math.floor(a / b);
  return r < 0 ? r + b : r;
};
const fixAngle = (a: number) => fix(a, 360);
const fixHour = (a: number) => fix(a, 24);

function julian(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

function sun(jd: number): { decl: number; eqt: number } {
  const d = jd - J2000;
  const g = fixAngle(357.529 + 0.98560028 * d);
  const q = fixAngle(280.459 + 0.98564736 * d);
  const l = fixAngle(q + 1.915 * Math.sin(rad(g)) + 0.02 * Math.sin(rad(2 * g)));
  const e = 23.439 - 0.00000036 * d;
  const ra = deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(l)), Math.cos(rad(l)))) / 15;
  return { decl: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(l)))), eqt: q / 15 - fixHour(ra) };
}

export interface PrayerOptions {
  method: PrayerMethod;
  asrSchool: AsrSchool;
}

/**
 * The day's times (YYYY-MM-DD, a calendar day at the place) as instants.
 * Hours are UTC from the date's midnight: the longitude carries the place.
 */
export function prayerTimes(
  date: string,
  lat: number,
  lng: number,
  options: PrayerOptions,
): Record<PrayerName, Date> {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const jd = julian(y, m, d) - lng / (15 * 24);
  const method = METHODS[options.method];
  const asrFactor = options.asrSchool === 'hanafi' ? 2 : 1;

  const midDay = (t: number) => fixHour(12 - sun(jd + t).eqt);
  const angleTime = (angle: number, t: number, before: boolean) => {
    const decl = sun(jd + t).decl;
    const noon = midDay(t);
    const cos =
      (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(lat))) /
      (Math.cos(rad(decl)) * Math.cos(rad(lat)));
    const span = deg(Math.acos(Math.max(-1, Math.min(1, cos)))) / 15;
    return noon + (before ? -span : span);
  };
  const asrTime = (t: number) => {
    const decl = sun(jd + t).decl;
    const angle = -deg(Math.atan(1 / (asrFactor + Math.tan(rad(Math.abs(lat - decl))))));
    return angleTime(angle, t, false);
  };

  // Two passes: each time recomputed at its own position of the day.
  let t = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18, isha: 18 };
  for (let pass = 0; pass < 2; pass += 1) {
    const p = (h: number) => h / 24;
    t = {
      fajr: angleTime(method.fajr, p(t.fajr), true),
      sunrise: angleTime(RISE_SET_ANGLE, p(t.sunrise), true),
      dhuhr: midDay(p(t.dhuhr)),
      asr: asrTime(p(t.asr)),
      maghrib: angleTime(RISE_SET_ANGLE, p(t.maghrib), false),
      isha: 'angle' in method.isha ? angleTime(method.isha.angle, p(t.isha), false) : t.isha,
    };
  }
  if ('minutes' in method.isha) t.isha = t.maghrib + method.isha.minutes / 60;

  const midnightUtc = Date.UTC(y, m - 1, d);
  const at = (localSolarHours: number) =>
    new Date(midnightUtc + Math.round((localSolarHours - lng / 15) * 3_600_000));
  return {
    fajr: at(t.fajr),
    sunrise: at(t.sunrise),
    dhuhr: at(t.dhuhr),
    asr: at(t.asr),
    maghrib: at(t.maghrib),
    isha: at(t.isha),
  };
}

/** Sehri ends at Fajr minus the caution; iftar is Maghrib plus it (tenant settings). */
export function sehriIftar(
  times: Record<PrayerName, Date>,
  sehriCautionMinutes: number,
  iftarCautionMinutes: number,
): { sehriEnds: Date; iftar: Date } {
  return {
    sehriEnds: new Date(times.fajr.getTime() - sehriCautionMinutes * 60_000),
    iftar: new Date(times.maghrib.getTime() + iftarCautionMinutes * 60_000),
  };
}

/** The tabular (Kuwaiti) Hijri date of a Gregorian day, moved by the area's adjustment. */
export function hijriDate(
  date: string,
  adjustDays: number,
): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const jdn = Math.floor(julian(y, m, d) + 0.5) + adjustDays;
  let l = jdn - 1948440 + 10632;
  const n = Math.floor((l - 1) / 10631);
  l = l - 10631 * n + 354;
  const j =
    Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) +
    Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l =
    l -
    Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) -
    Math.floor(j / 16) * Math.floor((15238 * j) / 43) +
    29;
  const month = Math.floor((24 * l) / 709);
  const day = l - Math.floor((709 * month) / 24);
  return { year: 30 * n + j - 30, month, day };
}

/** Ramadan is the ninth Hijri month. */
export const RAMADAN = 9;

/** The next prayer from `now` (sunrise is a time, not a prayer): today's, else tomorrow's Fajr. */
export function nextPrayer(
  today: Record<PrayerName, Date>,
  tomorrow: Record<PrayerName, Date>,
  now: Date,
): { prayer: PrayerName; at: Date } {
  for (const prayer of PRAYER_NAMES) {
    if (prayer !== 'sunrise' && today[prayer] > now) return { prayer, at: today[prayer] };
  }
  return { prayer: 'fajr', at: tomorrow.fajr };
}

/** YYYY-MM-DD of an instant in a timezone (the area's calendar day). */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
