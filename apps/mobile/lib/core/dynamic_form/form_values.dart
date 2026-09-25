import 'bn_numerals.dart';
import 'field_schema.dart';
import 'field_validator.dart';

/// What the form holds is what the user typed (strings in either digit
/// script for numbers, money and phones; bools; option lists). This turns it
/// into API values, leaving unparseable input as the raw string so the
/// validator reports `field.invalid` exactly as the server would, and drops
/// empty and hidden fields — a hidden field is never submitted.
/// (Port of packages/dynamic-form/src/form-values.ts.)
Map<String, Object> formStateToValues(
  CategoryFieldSchema schema,
  Map<String, Object?> state,
) {
  final values = <String, Object>{};
  for (final MapEntry(:key, value: property) in schema.properties.entries) {
    final raw = state[key];
    if (raw == null || raw == '' || (raw is List && raw.isEmpty)) continue;
    switch (property.type) {
      case FieldType.number:
        values[key] = raw is String ? (parseNumberInput(raw) ?? raw) : raw;
      case FieldType.money:
        values[key] = raw is String ? (parseMoneyInput(raw) ?? raw) : raw;
      case FieldType.phone:
        values[key] = raw is String ? normalizePhoneInput(raw) : raw;
      case FieldType.text:
      case FieldType.textarea:
        values[key] = raw is String ? raw.trim() : raw;
      default:
        values[key] = raw;
    }
    if (values[key] == '') values.remove(key);
  }
  final visible = visibleFields(schema, values);
  values.removeWhere((key, _) => !visible.contains(key));
  return values;
}

/// API values -> what the form shows (Bengali digits, grouped money, local phone).
Map<String, Object?> valuesToFormState(
  CategoryFieldSchema schema,
  Map<String, Object?> values,
  String locale,
) {
  final state = <String, Object?>{};
  for (final MapEntry(:key, :value) in values.entries) {
    final property = schema.properties[key];
    if (property == null || value == null) continue;
    state[key] = switch (property.type) {
      FieldType.number => localizeDigits('$value', locale),
      FieldType.money =>
        value is String ? formatMoney(value, locale) : '$value',
      FieldType.phone => localizeDigits(
        '$value'.replaceFirst(RegExp(r'^\+88'), ''),
        locale,
      ),
      _ => value,
    };
  }
  return state;
}
