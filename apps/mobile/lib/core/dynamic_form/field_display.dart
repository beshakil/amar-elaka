import 'package:intl/intl.dart';

import '../../l10n/app_localizations.dart';
import 'bn_numerals.dart';
import 'field_schema.dart';

/// A stored field value as a reader sees it (cards, detail pages, previews):
/// option labels instead of codes, Bengali digits, grouped money, a local
/// phone number. Null when there's nothing to show.
String? displayFieldValue(
  CategoryFieldSchema schema,
  String key,
  Object? value,
  AppLocalizations l10n,
  String locale,
) {
  final property = schema.properties[key];
  if (property == null || value == null || value == '') return null;
  switch (property.type) {
    case FieldType.select:
      return schema.optionLabel(key, '$value', locale);
    case FieldType.multiselect:
      final codes = value is List ? value : const [];
      if (codes.isEmpty) return null;
      return codes.map((c) => schema.optionLabel(key, '$c', locale)).join(', ');
    case FieldType.bool:
      return value == true ? l10n.dynamicFormYes : l10n.dynamicFormNo;
    case FieldType.money:
      final money = value is String
          ? (parseMoneyInput(value) ?? value)
          : '$value';
      return '৳ ${formatMoney(money, locale)}';
    case FieldType.number:
      final number = value is num ? value : parseNumberInput('$value');
      return number == null ? '$value' : formatNumber(number, locale);
    case FieldType.date:
      final date = DateTime.tryParse('$value');
      return date == null
          ? '$value'
          : localizeDigits(DateFormat.yMMMMd(locale).format(date), locale);
    case FieldType.phone:
      return localizeDigits(
        '$value'.replaceFirst(RegExp(r'^\+88'), ''),
        locale,
      );
    case FieldType.text:
    case FieldType.textarea:
      return '$value';
  }
}
