/// The capture form's rules (ADR 066), kept pure for tests.
library;

/// The API's own rule, checked first on the phone: a fix worse than
/// agent_min_gps_accuracy_m can't be saved.
bool accurateEnough(double? accuracyM, double minAccuracyM) =>
    accuracyM != null && accuracyM <= minAccuracyM;

/// How good the fix is, for the accuracy chip's colour.
enum FixQuality { none, poor, fair, good }

FixQuality fixQuality(double? accuracyM, double minAccuracyM) {
  if (accuracyM == null) return FixQuality.none;
  if (accuracyM > minAccuracyM) return FixQuality.poor;
  // Within half the limit is a good fix; up to the limit, fair.
  return accuracyM <= minAccuracyM / 2 ? FixQuality.good : FixQuality.fair;
}

/// Opening-hours presets for the quick-picker: [days] (ISO, 1 = Monday) open
/// [opens]–[closes]. A shop's hours in two taps; anything else is "custom".
class HoursPreset {
  const HoursPreset(this.key, this.days, this.opens, this.closes);

  final String key;
  final List<int> days;
  final String opens;
  final String closes;

  List<Map<String, Object>> toBusinessHours() => [
    for (final d in days) {'day': d, 'opens': opens, 'closes': closes},
  ];
}

// The usual Bangladeshi shop weeks (Friday = 5 off, or open every day).
const everyDay = [1, 2, 3, 4, 5, 6, 7];
const fridayOff = [1, 2, 3, 4, 6, 7];

const hoursPresets = [
  HoursPreset('daily_9_21', everyDay, '09:00', '21:00'),
  HoursPreset('daily_8_22', everyDay, '08:00', '22:00'),
  HoursPreset('fri_off_10_20', fridayOff, '10:00', '20:00'),
];
