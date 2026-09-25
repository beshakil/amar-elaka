import 'bn_numerals.dart';
import 'field_schema.dart';
import 'field_validator.dart';

/// The filter UI's state and its translation to the API's filter format
/// (`{field, op, value}`, what the server's parseFieldFilters accepts):
/// ranges -> gte/lte, selects -> in (eq for one), multiselects -> any, a
/// switched-on bool -> eq true. (Port of packages/dynamic-form/src/filters.ts.)

enum FilterControl { range, chips, toggle, text }

FilterControl? filterControlOf(FieldProperty property) =>
    switch (property.type) {
      FieldType.number ||
      FieldType.money ||
      FieldType.date => FilterControl.range,
      FieldType.select || FieldType.multiselect => FilterControl.chips,
      FieldType.bool => FilterControl.toggle,
      FieldType.text => FilterControl.text,
      _ => null,
    };

/// Range filter input, as typed.
class RangeState {
  const RangeState({this.min, this.max});

  final String? min;
  final String? max;

  RangeState copyWith({String? min, String? max}) =>
      RangeState(min: min ?? this.min, max: max ?? this.max);

  @override
  bool operator ==(Object other) =>
      other is RangeState && other.min == min && other.max == max;

  @override
  int get hashCode => Object.hash(min, max);
}

class RawFieldFilter {
  const RawFieldFilter(this.field, this.op, this.value);

  final String field;

  /// eq | gte | lte | in | any
  final String op;
  final String value;

  Map<String, String> toJson() => {'field': field, 'op': op, 'value': value};

  @override
  bool operator ==(Object other) =>
      other is RawFieldFilter &&
      other.field == field &&
      other.op == op &&
      other.value == value;

  @override
  int get hashCode => Object.hash(field, op, value);

  @override
  String toString() => '$field.$op=$value';
}

enum FilterIssueKind {
  invalidNumber,
  invalidInteger,
  invalidMoney,
  invalidDate,
  minAboveMax,
}

class FilterIssue {
  const FilterIssue(this.field, this.bound, this.kind);

  final String field;

  /// 'min' or 'max'.
  final String bound;
  final FilterIssueKind kind;

  @override
  bool operator ==(Object other) =>
      other is FilterIssue &&
      other.field == field &&
      other.bound == bound &&
      other.kind == kind;

  @override
  int get hashCode => Object.hash(field, bound, kind);

  @override
  String toString() => '$field.$bound: $kind';
}

/// Filterable fields that have a control, in display order.
List<String> filterFieldKeys(CategoryFieldSchema schema) => [
  for (final key in schema.order)
    if (schema.filterableFields.contains(key) &&
        schema.properties[key] != null &&
        filterControlOf(schema.properties[key]!) != null)
      key,
];

String? _rangeValue(FieldProperty property, String raw) {
  switch (property.type) {
    case FieldType.number:
      final value = parseNumberInput(raw);
      if (value == null) return null;
      if (property.integer && value != value.truncate()) return null;
      return value is int || value == value.truncate()
          ? value.toInt().toString()
          : value.toString();
    case FieldType.money:
      return parseMoneyInput(raw);
    case FieldType.date:
      return RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(raw) && isCalendarDay(raw)
          ? raw
          : null;
    default:
      return null;
  }
}

FilterIssueKind _invalidKind(FieldProperty property) => switch (property.type) {
  FieldType.money => FilterIssueKind.invalidMoney,
  FieldType.date => FilterIssueKind.invalidDate,
  _ =>
    property.integer
        ? FilterIssueKind.invalidInteger
        : FilterIssueKind.invalidNumber,
};

({List<RawFieldFilter> filters, List<FilterIssue> issues}) toRawFilters(
  CategoryFieldSchema schema,
  Map<String, Object?> state,
) {
  final filters = <RawFieldFilter>[];
  final issues = <FilterIssue>[];

  for (final field in filterFieldKeys(schema)) {
    final property = schema.properties[field]!;
    final value = state[field];
    if (value == null || value == '' || value == false) continue;

    switch (filterControlOf(property)!) {
      case FilterControl.range:
        if (value is! RangeState) continue;
        final parsed = <String, String>{};
        for (final (bound, raw, op) in [
          ('min', value.min, 'gte'),
          ('max', value.max, 'lte'),
        ]) {
          if (raw == null || raw.trim().isEmpty) continue;
          final normalized = _rangeValue(property, raw.trim());
          if (normalized == null) {
            issues.add(FilterIssue(field, bound, _invalidKind(property)));
            continue;
          }
          parsed[bound] = normalized;
          filters.add(RawFieldFilter(field, op, normalized));
        }
        final min = parsed['min'];
        final max = parsed['max'];
        if (min != null && max != null) {
          final minAboveMax = property.type == FieldType.date
              ? min.compareTo(max) > 0
              : num.parse(min) > num.parse(max);
          if (minAboveMax) {
            issues.add(FilterIssue(field, 'min', FilterIssueKind.minAboveMax));
          }
        }
      case FilterControl.chips:
        if (value is! List) continue;
        final codes = [
          for (final code in value)
            if (code is String && property.options.contains(code)) code,
        ];
        if (codes.isEmpty) continue;
        final op = property.type == FieldType.multiselect
            ? 'any'
            : codes.length == 1
            ? 'eq'
            : 'in';
        filters.add(RawFieldFilter(field, op, codes.join(',')));
      case FilterControl.toggle:
        if (value == true) filters.add(RawFieldFilter(field, 'eq', 'true'));
      case FilterControl.text:
        if (value is String && value.trim().isNotEmpty) {
          filters.add(RawFieldFilter(field, 'eq', value.trim()));
        }
    }
  }
  return (filters: filters, issues: issues);
}

/// How many fields have an active filter.
int activeFilterCount(CategoryFieldSchema schema, Map<String, Object?> state) =>
    toRawFilters(schema, state).filters.map((f) => f.field).toSet().length;

/// `f.bedrooms.gte=2&f.property_type.in=flat,house`, as the web client uses.
String filtersToQuery(List<RawFieldFilter> filters) => [
  for (final f in filters)
    '${Uri.encodeQueryComponent('f.${f.field}.${f.op}')}=${Uri.encodeQueryComponent(f.value)}',
].join('&');
