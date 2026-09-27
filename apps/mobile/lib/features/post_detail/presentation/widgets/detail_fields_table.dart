import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';

/// The post's fields as a clean two-column label/value table, labelled from
/// the schema version the post was written against (the API resolves it).
class DetailFieldsTable extends StatelessWidget {
  const DetailFieldsTable({required this.fields, super.key});

  final List<DetailField> fields;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final rows = [
      for (final field in fields)
        if (field.key != 'price')
          if (displayDetailValue(field, l10n, locale) case final value?)
            (field.label.of(locale) ?? field.key, value),
    ];
    if (rows.isEmpty) return const SizedBox.shrink();
    return Table(
      key: const ValueKey('detail-fields'),
      columnWidths: const {0: IntrinsicColumnWidth(), 1: FlexColumnWidth()},
      defaultVerticalAlignment: TableCellVerticalAlignment.top,
      children: [
        for (final (index, (label, value)) in rows.indexed)
          TableRow(
            decoration: BoxDecoration(
              color: index.isEven
                  ? theme.colorScheme.surfaceContainerLow
                  : Colors.transparent,
            ),
            children: [
              Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: Text(
                  label,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: Text(value, style: theme.textTheme.bodyMedium),
              ),
            ],
          ),
      ],
    );
  }
}

/// A field's value as a reader sees it: option labels, yes/no, grouped
/// money and Bengali digits. Null when there's nothing to show.
String? displayDetailValue(
  DetailField field,
  AppLocalizations l10n,
  String locale,
) {
  final value = field.value;
  if (value == null || value == '' || (value is List && value.isEmpty)) {
    return null;
  }
  switch (field.type) {
    case 'select':
    case 'multiselect':
      final labels = [
        for (final option in field.optionLabels ?? const <OptionalName>[])
          ?option.of(locale),
      ];
      if (labels.isNotEmpty) return labels.join(', ');
      return value is List ? value.join(', ') : '$value';
    case 'bool':
      return value == true ? l10n.detailYes : l10n.detailNo;
    case 'money':
      return '৳ ${formatMoney('$value', locale)}';
    case 'phone':
      return localizeDigits('$value'.replaceFirst('+88', ''), locale);
    default:
      return localizeDigits('$value', locale);
  }
}
