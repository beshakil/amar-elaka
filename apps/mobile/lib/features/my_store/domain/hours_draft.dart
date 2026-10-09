import '../../store/data/store_models.dart';

/// The week as people here read it: Saturday first (ISO 6, 7, 1 … 5).
const weekOrder = [6, 7, 1, 2, 3, 4, 5];

/// One shift as minutes after midnight; [closes] ≤ [opens] runs past midnight.
class Shift {
  const Shift(this.opens, this.closes);

  factory Shift.parse(String opens, String closes) =>
      Shift(_minutes(opens), _minutes(closes));

  final int opens;
  final int closes;

  static const minutesPerDay = 24 * 60;

  bool get overnight => closes <= opens;

  /// The minutes it covers on its own day (an overnight shift: to midnight).
  ({int from, int to}) get span =>
      (from: opens, to: overnight ? minutesPerDay : closes);

  static int _minutes(String hhmm) {
    final parts = hhmm.split(':');
    return int.parse(parts[0]) * 60 + int.parse(parts[1]);
  }

  static String format(int minutes) =>
      '${(minutes ~/ 60).toString().padLeft(2, '0')}:'
      '${(minutes % 60).toString().padLeft(2, '0')}';

  @override
  bool operator ==(Object other) =>
      other is Shift && other.opens == opens && other.closes == closes;

  @override
  int get hashCode => Object.hash(opens, closes);
}

sealed class HoursIssue {
  const HoursIssue(this.day);

  /// ISO weekday.
  final int day;
}

/// Opening and closing at the same minute.
final class SameTimes extends HoursIssue {
  const SameTimes(super.day);
}

/// Two shifts of one day cover the same time.
final class Overlap extends HoursIssue {
  const Overlap(super.day);
}

/// The weekly hours being edited (ADR 054/057): each day closed or open in
/// one or more shifts (split shifts — "9–1, then 3–9"). Checked here for
/// what the seller can fix on the spot; the API checks again (and how many
/// shifts a day may have, a setting).
class HoursDraft {
  HoursDraft(Map<int, List<Shift>> days)
    : days = {for (final d in weekOrder) d: List.of(days[d] ?? const [])};

  factory HoursDraft.fromWeekly(List<WeeklyRange> weekly) => HoursDraft({
    for (final d in weekOrder)
      d: [
        for (final r in weekly.where((r) => r.day == d))
          Shift.parse(r.opens, r.closes),
      ]..sort((a, b) => a.opens.compareTo(b.opens)),
  });

  final Map<int, List<Shift>> days;

  bool isOpen(int day) => days[day]!.isNotEmpty;

  /// Closed: no shifts. Opened again: one shift, a sensible default.
  void setOpen(int day, {required bool open, Shift fallback = defaultShift}) {
    days[day] = open ? (days[day]!.isEmpty ? [fallback] : days[day]!) : [];
  }

  // A shop's usual day, offered when a day is first opened.
  static const defaultShift = Shift(9 * 60, 21 * 60);

  void addShift(int day) {
    final shifts = days[day]!;
    final last = shifts.isEmpty ? null : shifts.last;
    // After the last one, an hour later, for two hours; else the default.
    final start = last == null || last.overnight
        ? defaultShift.opens
        : (last.closes + 60).clamp(0, Shift.minutesPerDay - 60);
    shifts.add(
      Shift(start, (start + 120).clamp(start + 1, Shift.minutesPerDay - 1)),
    );
  }

  void removeShift(int day, int index) => days[day]!.removeAt(index);

  void setShift(int day, int index, Shift shift) => days[day]![index] = shift;

  /// Every day gets [day]'s shifts (open days only).
  void copyToAll(int day) {
    final source = List.of(days[day]!);
    for (final d in weekOrder) {
      days[d] = List.of(source);
    }
  }

  List<HoursIssue> issues() {
    final found = <HoursIssue>[];
    for (final d in weekOrder) {
      final shifts = days[d]!;
      if (shifts.any((s) => s.opens == s.closes)) {
        found.add(SameTimes(d));
        continue;
      }
      final spans = [for (final s in shifts) s.span]
        ..sort((a, b) => a.from.compareTo(b.from));
      for (var i = 1; i < spans.length; i++) {
        if (spans[i].from < spans[i - 1].to) {
          found.add(Overlap(d));
          break;
        }
      }
    }
    return found;
  }

  /// What PUT /stores/:id/hours takes.
  List<WeeklyRange> toWeekly() => [
    for (final d in weekOrder)
      for (final s in days[d]!)
        WeeklyRange(
          day: d,
          opens: Shift.format(s.opens),
          closes: Shift.format(s.closes),
        ),
  ];
}
