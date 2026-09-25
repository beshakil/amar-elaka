import 'dart:math' as math;

import '../../l10n/app_localizations.dart';
import 'bn_numerals.dart';
import 'field_schema.dart';
import 'field_validator.dart';

/// Issue code + the field's rules -> a localized message with its numbers
/// filled in (Bengali digits, grouped money): "০ থেকে ২০-এর মধ্যে হতে হবে।".
/// The wording lives in l10n/app_*.arb (`dynamicFormError*`); this only
/// picks the message. (Port of packages/dynamic-form/src/messages.ts.)
String describeIssue(
  AppLocalizations l10n,
  CategoryFieldSchema schema,
  FieldIssue issue,
  String locale,
  ValidationContext context,
) {
  final property = schema.properties[issue.key];
  if (property == null) return l10n.dynamicFormErrorNotInSchema;
  String money(String value) => '৳${formatMoney(value, locale)}';
  String number(num value) => formatNumber(value, locale);

  switch (issue.code) {
    case FieldIssueCodes.required:
      return switch (property.type) {
        FieldType.date => l10n.dynamicFormErrorRequiredDate,
        FieldType.select ||
        FieldType.multiselect ||
        FieldType.bool => l10n.dynamicFormErrorRequiredChoice,
        _ => l10n.dynamicFormErrorRequired,
      };
    case FieldIssueCodes.invalid:
      return switch (property.type) {
        FieldType.number =>
          property.integer
              ? l10n.dynamicFormErrorInvalidInteger
              : l10n.dynamicFormErrorInvalidNumber,
        FieldType.money => l10n.dynamicFormErrorInvalidMoney,
        FieldType.date => l10n.dynamicFormErrorInvalidDate,
        FieldType.phone => l10n.dynamicFormErrorInvalidPhone,
        FieldType.text =>
          property.format == 'uri'
              ? l10n.dynamicFormErrorInvalidUrl
              : l10n.dynamicFormErrorInvalidFormat,
        _ => l10n.dynamicFormErrorInvalid,
      };
    case FieldIssueCodes.tooLong:
      return l10n.dynamicFormErrorTooLong(number(property.maxLength ?? 0));
    case FieldIssueCodes.outOfRange:
      if (property.type == FieldType.money) {
        final min = property.moneyMin;
        final max = property.moneyMax;
        if (min != null && max != null) {
          return l10n.dynamicFormErrorRangeBetween(money(min), money(max));
        }
        if (min != null) return l10n.dynamicFormErrorRangeMin(money(min));
        if (max != null) return l10n.dynamicFormErrorRangeMax(money(max));
        return l10n.dynamicFormErrorInvalidMoney;
      }
      final offset = property.maxCurrentYearOffset;
      final maxima = [
        ?property.maximum,
        if (offset != null) context.currentYear + offset,
      ];
      final max = maxima.isEmpty ? null : maxima.reduce(math.min);
      if (property.exclusiveMinimum != null) {
        return l10n.dynamicFormErrorRangeAbove(
          number(property.exclusiveMinimum!),
        );
      }
      if (property.minimum != null && max != null) {
        return l10n.dynamicFormErrorRangeBetween(
          number(property.minimum!),
          number(max),
        );
      }
      if (property.minimum != null) {
        return l10n.dynamicFormErrorRangeMin(number(property.minimum!));
      }
      if (max != null) return l10n.dynamicFormErrorRangeMax(number(max));
      return l10n.dynamicFormErrorInvalid;
    case FieldIssueCodes.notAnOption:
      return l10n.dynamicFormErrorNotAnOption;
    case FieldIssueCodes.duplicate:
      return l10n.dynamicFormErrorDuplicateOption;
    case FieldIssueCodes.beforeToday:
      return l10n.dynamicFormErrorBeforeToday;
    case FieldIssueCodes.lessThanField:
      final other = property.gteField;
      return l10n.dynamicFormErrorLessThanField(
        other == null ? '' : schema.label(other, locale),
      );
    case FieldIssueCodes.notApplicable:
      return l10n.dynamicFormErrorNotApplicable;
    case FieldIssueCodes.notInSchema:
      return l10n.dynamicFormErrorNotInSchema;
    default:
      return l10n.dynamicFormErrorInvalid;
  }
}
