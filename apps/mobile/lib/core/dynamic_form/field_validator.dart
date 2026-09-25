import 'field_schema.dart';

/// Client-side validation of category fields — a Dart port of the API's zod
/// validator (apps/api/src/categories/field-schema/fields-validator.ts) with
/// the same rules and the same issue codes, so the app rejects exactly what
/// the server would. field_validator_parity_test.dart replays the server's
/// own verdicts from test/fixtures/validation-cases.json.
///
/// One zod detail matters for identical results: a *type* problem (wrong
/// JSON type, a missing required field, null) aborts the object-level checks
/// (conditional fields, "required if", "≥ other field"), while a rule
/// problem (too long, out of range, not an option) doesn't. That is
/// reproduced here with the `aborted` flag.

abstract final class FieldIssueCodes {
  static const required = 'field.required';
  static const invalid = 'field.invalid';
  static const tooLong = 'field.too_long';
  static const outOfRange = 'field.out_of_range';
  static const notAnOption = 'field.not_an_option';
  static const duplicate = 'field.duplicate_option';
  static const beforeToday = 'field.before_today';
  static const lessThanField = 'field.less_than_field';
  static const notInSchema = 'field.not_in_schema';
  static const notApplicable = 'field.not_applicable';
}

class FieldIssue {
  const FieldIssue(this.field, this.code);

  factory FieldIssue.fromJson(Map<String, dynamic> json) =>
      FieldIssue(json['field'] as String, json['code'] as String);

  /// The field key, `key.index` inside a multiselect, or '' for the payload.
  final String field;
  final String code;

  /// The top-level field this issue belongs to.
  String get key => field.split('.').first;

  @override
  bool operator ==(Object other) =>
      other is FieldIssue && other.field == field && other.code == code;

  @override
  int get hashCode => Object.hash(field, code);

  @override
  String toString() => '$field: $code';
}

/// "Today" and the current year for date / model-year rules.
class ValidationContext {
  const ValidationContext({required this.today, required this.currentYear});

  /// Now in Asia/Dhaka. Bangladesh has a fixed UTC+6 offset and no daylight
  /// saving, so no timezone database is needed.
  factory ValidationContext.now([DateTime? at]) {
    final dhaka = (at ?? DateTime.now()).toUtc().add(_dhakaOffset);
    return ValidationContext(today: _isoDay(dhaka), currentYear: dhaka.year);
  }

  static const _dhakaOffset = Duration(hours: 6);

  /// `YYYY-MM-DD`.
  final String today;
  final int currentYear;
}

String _isoDay(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}'
    '-${d.day.toString().padLeft(2, '0')}';

final _moneyPattern = RegExp(r'^\d{1,10}\.\d{2}$');
final _datePattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final _bdPhonePattern = RegExp(r'^\+880\d{7,10}$');

BigInt _poisha(String money) => BigInt.parse(money.replaceFirst('.', ''));

/// Rejects impossible days like 2026-02-30, which DateTime would roll over.
bool isCalendarDay(String value) {
  final parsed = DateTime.tryParse('${value}T00:00:00Z');
  return parsed != null && _isoDay(parsed) == value;
}

/// Fields visible for these values (`x-show-when`); a hidden controller hides
/// its dependants.
Set<String> visibleFields(
  CategoryFieldSchema schema,
  Map<String, Object?> values,
) {
  final memo = <String, bool>{};
  final visiting = <String>{};
  late bool Function(String) isVisible;
  isVisible = (key) {
    final known = memo[key];
    if (known != null) return known;
    final rule = schema.properties[key]?.showWhen;
    var visible = true;
    if (rule != null) {
      if (visiting.contains(key)) return false;
      visiting.add(key);
      final value = values[rule.field];
      final matches = value is List
          ? value.any(rule.values.contains)
          : (value is String || value is bool) && rule.values.contains(value);
      visible = matches && isVisible(rule.field);
      visiting.remove(key);
    }
    memo[key] = visible;
    return visible;
  };
  return {
    for (final key in schema.properties.keys)
      if (isVisible(key)) key,
  };
}

class _Check {
  final issues = <FieldIssue>[];
  var aborted = false;

  void add(String field, String code) => issues.add(FieldIssue(field, code));

  void abort(String field, String code) {
    add(field, code);
    aborted = true;
  }
}

/// Validates API-shaped values (what posts.fields holds); empty when valid.
List<FieldIssue> validateFieldValues(
  CategoryFieldSchema schema,
  Object? payload,
  ValidationContext context,
) {
  if (payload is! Map) return const [FieldIssue('', FieldIssueCodes.invalid)];
  final values = Map<String, Object?>.from(payload);
  final check = _Check();
  final parsed = <String, Object?>{};

  for (final MapEntry(:key, value: property) in schema.properties.entries) {
    final conditional = property.showWhen != null;
    final alwaysRequired = schema.required.contains(key) && !conditional;
    if (!values.containsKey(key)) {
      if (alwaysRequired) check.abort(key, FieldIssueCodes.required);
      continue;
    }
    parsed[key] = _checkProperty(key, property, values[key], context, check);
  }

  for (final key in values.keys) {
    if (!schema.properties.containsKey(key)) {
      check.add(key, FieldIssueCodes.notInSchema);
    }
  }

  if (!check.aborted) _checkCrossField(schema, parsed, check);
  return check.issues;
}

/// Checks one present value; returns it as zod would pass it on (trimmed text).
Object? _checkProperty(
  String key,
  FieldProperty property,
  Object? value,
  ValidationContext context,
  _Check check,
) {
  switch (property.type) {
    case FieldType.text:
    case FieldType.textarea:
      if (value is! String) {
        check.abort(key, FieldIssueCodes.invalid);
        return value;
      }
      final text = value.trim();
      if (text.isEmpty) check.add(key, FieldIssueCodes.required);
      if (text.length > property.maxLength!) {
        check.add(key, FieldIssueCodes.tooLong);
      }
      if (property.pattern != null &&
          !RegExp(property.pattern!).hasMatch(text)) {
        check.add(key, FieldIssueCodes.invalid);
      }
      if (property.format == 'uri') {
        if (Uri.tryParse(text)?.hasScheme != true) {
          check.add(key, FieldIssueCodes.invalid);
        }
        if (!text.startsWith('https://')) {
          check.add(key, FieldIssueCodes.invalid);
        }
      }
      return text;

    case FieldType.number:
      if (value is! num || value.isNaN) {
        check.abort(key, FieldIssueCodes.invalid);
        return value;
      }
      if (value.isInfinite) check.add(key, FieldIssueCodes.invalid);
      if (property.integer && value != value.truncateToDouble()) {
        check.add(key, FieldIssueCodes.invalid);
      }
      if (property.minimum != null && value < property.minimum!) {
        check.add(key, FieldIssueCodes.outOfRange);
      }
      if (property.exclusiveMinimum != null &&
          value <= property.exclusiveMinimum!) {
        check.add(key, FieldIssueCodes.outOfRange);
      }
      if (property.maximum != null && value > property.maximum!) {
        check.add(key, FieldIssueCodes.outOfRange);
      }
      final offset = property.maxCurrentYearOffset;
      if (offset != null && value > context.currentYear + offset) {
        check.add(key, FieldIssueCodes.outOfRange);
      }
      return value;

    case FieldType.money:
      if (value is! String) {
        check.abort(key, FieldIssueCodes.invalid);
        return value;
      }
      if (!_moneyPattern.hasMatch(value)) {
        check.add(key, FieldIssueCodes.invalid);
        return value;
      }
      final amount = _poisha(value);
      final min = property.moneyMin;
      final max = property.moneyMax;
      if ((min != null && amount < _poisha(min)) ||
          (max != null && amount > _poisha(max))) {
        check.add(key, FieldIssueCodes.outOfRange);
      }
      return value;

    case FieldType.bool:
      if (value is! bool) check.abort(key, FieldIssueCodes.invalid);
      return value;

    case FieldType.select:
      if (value is! String) {
        check.abort(key, FieldIssueCodes.invalid);
      } else if (!property.options.contains(value)) {
        check.add(key, FieldIssueCodes.notAnOption);
      }
      return value;

    case FieldType.multiselect:
      if (value is! List) {
        check.abort(key, FieldIssueCodes.invalid);
        return value;
      }
      if (value.length < (property.minItems ?? 0)) {
        check.add(key, FieldIssueCodes.required);
      }
      var itemAborted = false;
      for (final (index, item) in value.indexed) {
        if (item is! String) {
          check.abort('$key.$index', FieldIssueCodes.invalid);
          itemAborted = true;
        } else if (!property.options.contains(item)) {
          check.add('$key.$index', FieldIssueCodes.notAnOption);
        }
      }
      // zod skips the duplicate refinement once an item's type is wrong.
      if (!itemAborted && value.toSet().length != value.length) {
        check.add(key, FieldIssueCodes.duplicate);
      }
      return value;

    case FieldType.date:
      if (value is! String) {
        check.abort(key, FieldIssueCodes.invalid);
        return value;
      }
      if (!_datePattern.hasMatch(value) || !isCalendarDay(value)) {
        check.add(key, FieldIssueCodes.invalid);
      } else if (property.notBeforeToday &&
          value.compareTo(context.today) < 0) {
        check.add(key, FieldIssueCodes.beforeToday);
      }
      return value;

    case FieldType.phone:
      if (value is! String) {
        check.abort(key, FieldIssueCodes.invalid);
      } else if (!_bdPhonePattern.hasMatch(value)) {
        check.add(key, FieldIssueCodes.invalid);
      }
      return value;
  }
}

void _checkCrossField(
  CategoryFieldSchema schema,
  Map<String, Object?> values,
  _Check check,
) {
  final conditional = [
    for (final entry in schema.properties.entries)
      if (entry.value.showWhen != null) entry.key,
  ];
  if (conditional.isNotEmpty) {
    final visible = visibleFields(schema, values);
    for (final key in conditional) {
      final present = values.containsKey(key);
      if (!visible.contains(key) && present) {
        check.add(key, FieldIssueCodes.notApplicable);
      }
      if (visible.contains(key) && !present && schema.required.contains(key)) {
        check.add(key, FieldIssueCodes.required);
      }
    }
  }

  for (final rule in schema.allOf) {
    final applies =
        rule.ifRequired.every(values.containsKey) &&
        rule.ifEnum.entries.every((e) {
          final value = values[e.key];
          return value is String && e.value.contains(value);
        });
    if (!applies) continue;
    for (final key in rule.thenRequired) {
      if (!values.containsKey(key)) check.add(key, FieldIssueCodes.required);
    }
  }

  for (final MapEntry(:key, value: property) in schema.properties.entries) {
    final other = property.gteField;
    if (other == null) continue;
    final value = values[key];
    final otherValue = values[other];
    if (value == null || otherValue == null) continue;
    final bool less;
    if (property.type == FieldType.money) {
      if (value is! String ||
          otherValue is! String ||
          !_moneyPattern.hasMatch(value) ||
          !_moneyPattern.hasMatch(otherValue)) {
        continue;
      }
      less = _poisha(value) < _poisha(otherValue);
    } else if (value is num && otherValue is num) {
      less = value < otherValue;
    } else {
      continue;
    }
    if (less) check.add(key, FieldIssueCodes.lessThanField);
  }
}

/// For forms: everything [validateFieldValues] reports, plus every visible
/// required field that is still empty. zod (and so the server) skips the
/// conditional "required while shown" checks while any field has a type
/// problem (e.g. a required date left empty) — right for an API, but a form
/// would then reveal its errors one submit at a time. The server's verdict
/// is unchanged; the form just shows it all at once.
List<FieldIssue> formFieldIssues(
  CategoryFieldSchema schema,
  Map<String, Object?> values,
  ValidationContext context,
) {
  final issues = [...validateFieldValues(schema, values, context)];
  final seen = issues.toSet();
  void add(String key) {
    final issue = FieldIssue(key, FieldIssueCodes.required);
    if (seen.add(issue)) issues.add(issue);
  }

  final visible = visibleFields(schema, values);
  for (final key in schema.required) {
    if (visible.contains(key) && !values.containsKey(key)) add(key);
  }
  for (final rule in schema.allOf) {
    final applies =
        rule.ifRequired.every(values.containsKey) &&
        rule.ifEnum.entries.every((e) {
          final value = values[e.key];
          return value is String && e.value.contains(value);
        });
    if (!applies) continue;
    for (final key in rule.thenRequired) {
      if (!values.containsKey(key)) add(key);
    }
  }
  return issues;
}
