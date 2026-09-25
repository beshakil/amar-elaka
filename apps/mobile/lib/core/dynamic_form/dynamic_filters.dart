import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../design/tokens/app_spacing.dart';
import '../design/tokens/app_typography.dart';
import '../design/widgets/app_button.dart';
import '../design/widgets/app_form_controls.dart';
import '../design/widgets/app_text_field.dart';
import 'bn_numerals.dart';
import 'field_schema.dart';
import 'filters.dart';

typedef FilterResult = ({
  List<RawFieldFilter> filters,
  List<FilterIssue> issues,
});

/// The filter panel for a category, driven by the same field schema as
/// [DynamicForm]: number/money/date -> a min–max range, select/multiselect
/// -> chips, bool -> a switch, short text -> exact match. Every change
/// reports the API filters (filters.dart) plus any problems to show.
class DynamicFilters extends StatefulWidget {
  const DynamicFilters({
    required this.schema,
    required this.onChanged,
    super.key,
  });

  final CategoryFieldSchema schema;
  final void Function(Map<String, Object?> state, FilterResult result)
  onChanged;

  @override
  State<DynamicFilters> createState() => _DynamicFiltersState();
}

class _DynamicFiltersState extends State<DynamicFilters> {
  final Map<String, Object?> _state = {};
  final Map<String, (TextEditingController, TextEditingController)> _ranges =
      {};
  final Map<String, (FocusNode, FocusNode)> _rangeFocus = {};
  final Map<String, TextEditingController> _texts = {};

  CategoryFieldSchema get _schema => widget.schema;

  @override
  void initState() {
    super.initState();
    for (final key in filterFieldKeys(_schema)) {
      final property = _schema.properties[key]!;
      switch (filterControlOf(property)) {
        case FilterControl.range:
          _ranges[key] = (TextEditingController(), TextEditingController());
          FocusNode tidyOnLeave(bool isMin) {
            final node = FocusNode();
            node.addListener(() {
              if (!node.hasFocus) _tidy(key, isMin);
            });
            return node;
          }

          _rangeFocus[key] = (tidyOnLeave(true), tidyOnLeave(false));
        case FilterControl.text:
          _texts[key] = TextEditingController();
        default:
          break;
      }
    }
  }

  @override
  void dispose() {
    for (final (a, b) in _ranges.values) {
      a.dispose();
      b.dispose();
    }
    for (final (a, b) in _rangeFocus.values) {
      a.dispose();
      b.dispose();
    }
    for (final c in _texts.values) {
      c.dispose();
    }
    super.dispose();
  }

  String get _locale => Localizations.localeOf(context).languageCode;

  void _emit() {
    setState(() {});
    widget.onChanged(Map.of(_state), toRawFilters(_schema, _state));
  }

  void _syncRange(String key) {
    final (min, max) = _ranges[key]!;
    _state[key] = RangeState(min: min.text, max: max.text);
    _emit();
  }

  /// Leaving a bound: Bengali digits, grouped money.
  void _tidy(String key, bool isMin) {
    final (minC, maxC) = _ranges[key]!;
    final controller = isMin ? minC : maxC;
    final property = _schema.properties[key]!;
    final text = controller.text;
    final tidy = switch (property.type) {
      FieldType.money => switch (parseMoneyInput(text)) {
        final String m => formatMoney(m, _locale),
        null => null,
      },
      FieldType.number => switch (parseNumberInput(text)) {
        final num n => formatNumber(n, _locale),
        null => null,
      },
      _ => null,
    };
    if (tidy != null && tidy != text) {
      controller.text = tidy;
      _syncRange(key);
    }
  }

  void _clear() {
    _state.clear();
    for (final (a, b) in _ranges.values) {
      a.clear();
      b.clear();
    }
    for (final c in _texts.values) {
      c.clear();
    }
    _emit();
  }

  String _issueText(AppLocalizations l10n, FilterIssueKind kind) =>
      switch (kind) {
        FilterIssueKind.invalidNumber => l10n.dynamicFormErrorInvalidNumber,
        FilterIssueKind.invalidInteger => l10n.dynamicFormErrorInvalidInteger,
        FilterIssueKind.invalidMoney => l10n.dynamicFormErrorInvalidMoney,
        FilterIssueKind.invalidDate => l10n.dynamicFormErrorInvalidDate,
        FilterIssueKind.minAboveMax => l10n.dynamicFormErrorMinAboveMax,
      };

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = _locale;
    final keys = filterFieldKeys(_schema);
    if (keys.isEmpty) return Text(l10n.dynamicFormNoFilterableFields);

    final result = toRawFilters(_schema, _state);
    final active = activeFilterCount(_schema, _state);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  l10n.dynamicFormActiveFilters(
                    active,
                    localizeDigits('$active', locale),
                  ),
                  style: AppTypography.labelLarge,
                ),
              ),
            ),
            if (active > 0)
              AppButton(
                label: l10n.dynamicFormClearFilters,
                variant: AppButtonVariant.text,
                onPressed: _clear,
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        for (final key in keys) ...[
          _control(key, l10n, locale, result.issues),
          const SizedBox(height: AppSpacing.md),
        ],
      ],
    );
  }

  Widget _control(
    String key,
    AppLocalizations l10n,
    String locale,
    List<FilterIssue> issues,
  ) {
    final property = _schema.properties[key]!;
    final label = _schema.label(key, locale);
    switch (filterControlOf(property)!) {
      case FilterControl.range:
        final (min, max) = _ranges[key]!;
        final (minFocus, maxFocus) = _rangeFocus[key]!;
        final mine = issues.where((i) => i.field == key).toList();
        return AppRangeField(
          label: label,
          minLabel: l10n.dynamicFormMin,
          maxLabel: l10n.dynamicFormMax,
          minController: min,
          maxController: max,
          minFocusNode: minFocus,
          maxFocusNode: maxFocus,
          prefixText: property.type == FieldType.money ? '৳ ' : null,
          keyboardType: switch (property.type) {
            FieldType.number when property.integer => TextInputType.number,
            FieldType.date => TextInputType.datetime,
            _ => const TextInputType.numberWithOptions(decimal: true),
          },
          minError: mine.any((i) => i.bound == 'min'),
          maxError: mine.any((i) => i.bound == 'max'),
          errorText: mine.isEmpty
              ? null
              : mine.map((i) => _issueText(l10n, i.kind)).toSet().join(' '),
          onChanged: () => _syncRange(key),
        );
      case FilterControl.chips:
        final selected = List<String>.from((_state[key] as List?) ?? const []);
        return AppChoiceChips<String>(
          label: label,
          multiple: true,
          options: [
            for (final code in property.options)
              AppSelectOption(code, _schema.optionLabel(key, code, locale)),
          ],
          selected: selected.toSet(),
          onChanged: (s) {
            _state[key] = [
              for (final code in property.options)
                if (s.contains(code)) code,
            ];
            _emit();
          },
        );
      case FilterControl.toggle:
        return AppSwitchTile(
          label: label,
          value: _state[key] == true,
          onChanged: (on) {
            _state[key] = on;
            _emit();
          },
        );
      case FilterControl.text:
        return AppTextField(
          label: label,
          controller: _texts[key],
          onChanged: (value) {
            _state[key] = value;
            _emit();
          },
        );
    }
  }
}
