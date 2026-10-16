/// Prayer times calculated on the device from coordinates — no API
/// (ADR 065). The standard astronomical method (the PrayTimes.org formulas).
/// The TypeScript twin is apps/web/src/lib/info/prayer.ts; both are checked
/// against the same vectors.
///
/// Methods (Fajr angle, Isha angle or minutes after Maghrib): karachi 18°/18°
/// (Bangladesh's usual), mwl 18°/17°, isna 15°/15°, egypt 19.5°/17.5°,
/// umm_al_qura 18.5°/90 min.
library;

import 'dart:math' as math;

enum Prayer { fajr, sunrise, dhuhr, asr, maghrib, isha }

typedef PrayerDay = Map<Prayer, DateTime>;

class _Method {
  const _Method(this.fajr, {this.ishaAngle, this.ishaMinutes});
  final double fajr;
  final double? ishaAngle;
  final int? ishaMinutes;
}

const _methods = <String, _Method>{
  'karachi': _Method(18, ishaAngle: 18),
  'mwl': _Method(18, ishaAngle: 17),
  'isna': _Method(15, ishaAngle: 15),
  'egypt': _Method(19.5, ishaAngle: 17.5),
  'umm_al_qura': _Method(18.5, ishaMinutes: 90),
};

// Astronomy constants (facts, not settings): refraction + the sun's radius.
const _riseSetAngle = 0.833;
const _j2000 = 2451545.0;

double _rad(double d) => d * math.pi / 180;
double _deg(double r) => r * 180 / math.pi;
double _fix(double a, double b) {
  final r = a - b * (a / b).floorToDouble();
  return r < 0 ? r + b : r;
}

double _fixAngle(double a) => _fix(a, 360);
double _fixHour(double a) => _fix(a, 24);

double _julian(int year, int month, int day) {
  var y = year;
  var m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  final a = (y / 100).floor();
  final b = 2 - a + (a / 4).floor();
  return (365.25 * (y + 4716)).floorToDouble() +
      (30.6001 * (m + 1)).floorToDouble() +
      day +
      b -
      1524.5;
}

({double decl, double eqt}) _sun(double jd) {
  final d = jd - _j2000;
  final g = _fixAngle(357.529 + 0.98560028 * d);
  final q = _fixAngle(280.459 + 0.98564736 * d);
  final l = _fixAngle(
    q + 1.915 * math.sin(_rad(g)) + 0.02 * math.sin(_rad(2 * g)),
  );
  final e = 23.439 - 0.00000036 * d;
  final ra =
      _deg(
        math.atan2(math.cos(_rad(e)) * math.sin(_rad(l)), math.cos(_rad(l))),
      ) /
      15;
  return (
    decl: _deg(math.asin(math.sin(_rad(e)) * math.sin(_rad(l)))),
    eqt: q / 15 - _fixHour(ra),
  );
}

/// The day's times for a calendar day at the place, as UTC instants.
PrayerDay prayerTimes(
  DateTime date,
  double lat,
  double lng, {
  required String method,
  required String asrSchool,
}) {
  final jd = _julian(date.year, date.month, date.day) - lng / (15 * 24);
  final m = _methods[method] ?? _methods['karachi']!;
  final asrFactor = asrSchool == 'hanafi' ? 2 : 1;

  double midDay(double t) => _fixHour(12 - _sun(jd + t).eqt);
  double angleTime(double angle, double t, {required bool before}) {
    final decl = _sun(jd + t).decl;
    final noon = midDay(t);
    final c =
        (-math.sin(_rad(angle)) - math.sin(_rad(decl)) * math.sin(_rad(lat))) /
        (math.cos(_rad(decl)) * math.cos(_rad(lat)));
    final span = _deg(math.acos(c.clamp(-1.0, 1.0))) / 15;
    return noon + (before ? -span : span);
  }

  double asrTime(double t) {
    final decl = _sun(jd + t).decl;
    final angle = -_deg(
      math.atan(1 / (asrFactor + math.tan(_rad((lat - decl).abs())))),
    );
    return angleTime(angle, t, before: false);
  }

  // Two passes: each time recomputed at its own position of the day.
  var t = <Prayer, double>{
    Prayer.fajr: 5,
    Prayer.sunrise: 6,
    Prayer.dhuhr: 12,
    Prayer.asr: 13,
    Prayer.maghrib: 18,
    Prayer.isha: 18,
  };
  for (var pass = 0; pass < 2; pass++) {
    double p(Prayer k) => t[k]! / 24;
    t = {
      Prayer.fajr: angleTime(m.fajr, p(Prayer.fajr), before: true),
      Prayer.sunrise: angleTime(_riseSetAngle, p(Prayer.sunrise), before: true),
      Prayer.dhuhr: midDay(p(Prayer.dhuhr)),
      Prayer.asr: asrTime(p(Prayer.asr)),
      Prayer.maghrib: angleTime(
        _riseSetAngle,
        p(Prayer.maghrib),
        before: false,
      ),
      Prayer.isha: m.ishaAngle != null
          ? angleTime(m.ishaAngle!, p(Prayer.isha), before: false)
          : t[Prayer.isha]!,
    };
  }
  if (m.ishaMinutes != null) {
    t[Prayer.isha] = t[Prayer.maghrib]! + m.ishaMinutes! / 60;
  }

  final midnight = DateTime.utc(date.year, date.month, date.day);
  return {
    for (final e in t.entries)
      e.key: midnight.add(
        Duration(milliseconds: ((e.value - lng / 15) * 3600000).round()),
      ),
  };
}

/// Sehri ends at Fajr minus the caution; iftar is Maghrib plus it.
({DateTime sehriEnds, DateTime iftar}) sehriIftar(
  PrayerDay day, {
  required int sehriCautionMinutes,
  required int iftarCautionMinutes,
}) => (
  sehriEnds: day[Prayer.fajr]!.subtract(Duration(minutes: sehriCautionMinutes)),
  iftar: day[Prayer.maghrib]!.add(Duration(minutes: iftarCautionMinutes)),
);

/// The tabular (Kuwaiti) Hijri date of a Gregorian day, moved by the area's adjustment.
({int year, int month, int day}) hijriDate(DateTime date, int adjustDays) {
  final jdn =
      (_julian(date.year, date.month, date.day) + 0.5).floor() + adjustDays;
  var l = jdn - 1948440 + 10632;
  final n = ((l - 1) / 10631).floor();
  l = l - 10631 * n + 354;
  final j =
      ((10985 - l) / 5316).floor() * ((50 * l) / 17719).floor() +
      (l / 5670).floor() * ((43 * l) / 15238).floor();
  l =
      l -
      ((30 - j) / 15).floor() * ((17719 * j) / 50).floor() -
      (j / 16).floor() * ((15238 * j) / 43).floor() +
      29;
  final month = ((24 * l) / 709).floor();
  final day = l - ((709 * month) / 24).floor();
  return (year: 30 * n + j - 30, month: month, day: day);
}

/// Ramadan is the ninth Hijri month.
const ramadan = 9;

/// The next prayer (not sunrise) after [now], from today's and tomorrow's times.
({Prayer prayer, DateTime at})? nextPrayer(
  PrayerDay today,
  PrayerDay tomorrow,
  DateTime now,
) {
  for (final day in [today, tomorrow]) {
    for (final p in Prayer.values) {
      if (p == Prayer.sunrise) continue;
      final at = day[p]!;
      if (at.isAfter(now)) return (prayer: p, at: at);
    }
  }
  return null;
}
