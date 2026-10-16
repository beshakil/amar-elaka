import '../../../core/dynamic_form/bn_numerals.dart';
import '../data/info_models.dart';

/// The fast entry sheet's state (ADR 064), pure so it is unit-tested alone:
/// one min/max pair per item, prefilled with what is saved for the day, else
/// the previous day's figure; typed in either script; compared in poisha.
class BazarEntryForm {
  BazarEntryForm(this.sheet)
    : _min = [
        for (final i in sheet.items) _display((i.entered ?? i.previous)?.min),
      ],
      _max = [
        for (final i in sheet.items) _display((i.entered ?? i.previous)?.max),
      ];

  final BazarEntrySheet sheet;
  final List<String> _min;
  final List<String> _max;

  String minAt(int index) => _min[index];
  String maxAt(int index) => _max[index];

  void setMin(int index, String value) => _min[index] = value;
  void setMax(int index, String value) => _max[index] = value;

  /// A single price typed in min only means min = max.
  ({String min, String max})? _pair(int index) {
    final min = parseMoneyInput(_min[index]);
    final max = parseMoneyInput(
      _max[index].trim().isEmpty ? _min[index] : _max[index],
    );
    if (min == null || max == null) return null;
    return (min: min, max: max);
  }

  /// Rows that would be saved; blank rows are skipped.
  int get filled => [
    for (var i = 0; i < sheet.items.length; i++)
      if (_min[i].trim().isNotEmpty) i,
  ].length;

  /// The first row whose figures don't parse or whose max is below min.
  int? get firstInvalid {
    for (var i = 0; i < sheet.items.length; i++) {
      if (_min[i].trim().isEmpty && _max[i].trim().isEmpty) continue;
      final pair = _pair(i);
      if (pair == null || _poisha(pair.max) < _poisha(pair.min)) return i;
      if (_poisha(pair.min) == 0) return i;
    }
    return null;
  }

  /// What PUT /bazar/entry gets: every filled, valid row.
  List<BazarEntryLine> lines() => [
    for (var i = 0; i < sheet.items.length; i++)
      if (_min[i].trim().isNotEmpty)
        if (_pair(i) case final pair?)
          BazarEntryLine(
            commodityId: sheet.items[i].commodityId,
            unit: sheet.items[i].unit,
            min: pair.min,
            max: pair.max,
          ),
  ];

  static String _display(String? money) {
    if (money == null) return '';
    return money.endsWith('.00') ? money.substring(0, money.length - 3) : money;
  }

  static int _poisha(String money) {
    final parts = money.split('.');
    return int.parse(parts[0]) * 100 +
        int.parse(parts.length > 1 ? parts[1].padRight(2, '0') : '0');
  }
}
