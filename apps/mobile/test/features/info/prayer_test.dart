import 'package:amar_elaka_app/features/info/prayer/prayer_times.dart';
import 'package:flutter_test/flutter_test.dart';

/// The same vectors as apps/web/src/lib/info/prayer.test.ts: Dhaka, Karachi
/// method, Hanafi Asr, within 3 minutes of the Islamic Foundation timetable.
void main() {
  const lat = 23.8103;
  const lng = 90.4125;
  const dhaka = Duration(hours: 6);

  int minutesOfDay(DateTime utc) {
    final local = utc.add(dhaka);
    return local.hour * 60 + local.minute;
  }

  void near(DateTime actual, String expected) {
    final parts = expected.split(':').map(int.parse).toList();
    expect(
      (minutesOfDay(actual) - (parts[0] * 60 + parts[1])).abs(),
      lessThanOrEqualTo(3),
      reason: 'expected about $expected',
    );
  }

  PrayerDay at(
    String date, {
    String asr = 'hanafi',
    String method = 'karachi',
  }) => prayerTimes(
    DateTime.parse(date),
    lat,
    lng,
    method: method,
    asrSchool: asr,
  );

  test('matches the Dhaka timetable', () {
    final t = at('2026-10-16');
    near(t[Prayer.fajr]!, '04:40');
    near(t[Prayer.sunrise]!, '05:54');
    near(t[Prayer.dhuhr]!, '11:44');
    near(t[Prayer.asr]!, '15:56');
    near(t[Prayer.maghrib]!, '17:33');
    near(t[Prayer.isha]!, '18:47');
  });

  test('follows the seasons', () {
    final june = at('2026-06-21');
    near(june[Prayer.fajr]!, '03:43');
    near(june[Prayer.maghrib]!, '18:48');
    final dec = at('2026-12-21');
    near(dec[Prayer.fajr]!, '05:15');
    near(dec[Prayer.maghrib]!, '17:16');
  });

  test('puts the standard Asr before the Hanafi one', () {
    expect(
      at(
        '2026-10-16',
        asr: 'standard',
      )[Prayer.asr]!.isBefore(at('2026-10-16')[Prayer.asr]!),
      isTrue,
    );
  });

  test('places Umm al-Qura isha 90 minutes after maghrib', () {
    final u = at('2026-10-16', method: 'umm_al_qura', asr: 'standard');
    expect(
      u[Prayer.isha]!.difference(u[Prayer.maghrib]!),
      const Duration(minutes: 90),
    );
  });

  test('moves sehri and iftar by the caution minutes', () {
    final t = at('2026-10-16');
    final s = sehriIftar(t, sehriCautionMinutes: 3, iftarCautionMinutes: 2);
    expect(t[Prayer.fajr]!.difference(s.sehriEnds), const Duration(minutes: 3));
    expect(s.iftar.difference(t[Prayer.maghrib]!), const Duration(minutes: 2));
  });

  test('finds the next prayer, into tomorrow after isha', () {
    final today = at('2026-10-16');
    final tomorrow = at('2026-10-17');
    expect(
      nextPrayer(
        today,
        tomorrow,
        today[Prayer.dhuhr]!.add(const Duration(minutes: 1)),
      )!.prayer,
      Prayer.asr,
    );
    final late = nextPrayer(
      today,
      tomorrow,
      today[Prayer.isha]!.add(const Duration(minutes: 1)),
    )!;
    expect((late.prayer, late.at), (Prayer.fajr, tomorrow[Prayer.fajr]));
  });

  test('gives the Hijri date, Ramadan included', () {
    expect(hijriDate(DateTime(2026, 3, 1), 0), (year: 1447, month: 9, day: 12));
    expect(hijriDate(DateTime(2026, 10, 16), 0), (
      year: 1448,
      month: 5,
      day: 4,
    ));
  });
}
