import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:intl/intl.dart';

import '../../l10n/app_localizations.dart';
import '../design/tokens/app_spacing.dart';
import '../design/widgets/app_button.dart';
import '../design/widgets/app_form_controls.dart';
import '../design/widgets/app_text_field.dart';
import 'bn_numerals.dart';
import 'field_messages.dart';
import 'field_schema.dart';
import 'field_validator.dart';
import 'form_values.dart';

/// Renders a category field schema as a form, built only from design-system
/// widgets. Values come out API-shaped (Latin digits, "15000.00" money,
/// E.164 phones) and already checked with the server's rules
/// (field_validator.dart); hidden conditional fields are never submitted.
///
/// Errors appear once a field has been left, and for every field after a
/// submit attempt; a failed submit announces a summary to screen readers and
/// moves focus to the first invalid field.
class DynamicForm extends StatefulWidget {
  const DynamicForm({
    required this.schema,
    required this.onSubmit,
    super.key,
    this.initialValues,
    this.validationContext,
    this.submitLabel,
  });

  final CategoryFieldSchema schema;
  final ValueChanged<Map<String, Object>> onSubmit;

  /// Stored values to edit (a post's `fields`).
  final Map<String, Object?>? initialValues;

  /// "Today" and the current year; defaults to now in Asia/Dhaka.
  final ValidationContext? validationContext;
  final String? submitLabel;

  @override
  State<DynamicForm> createState() => _DynamicFormState();
}

/// Selects with this many options or fewer render as one-tap chips.
const _chipSelectMaxOptions = 4;

const _textLike = {
  FieldType.text,
  FieldType.textarea,
  FieldType.number,
  FieldType.money,
  FieldType.phone,
};

class _DynamicFormState extends State<DynamicForm> {
  late final ValidationContext _context =
      widget.validationContext ?? ValidationContext.now();
  final Map<String, Object?> _state = {};
  final Map<String, TextEditingController> _controllers = {};
  final Map<String, FocusNode> _focusNodes = {};
  final Set<String> _touched = {};
  bool _submitted = false;
  String? _locale;

  CategoryFieldSchema get _schema => widget.schema;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_locale != null) return;
    _locale = Localizations.localeOf(context).languageCode;
    _state.addAll(
      valuesToFormState(_schema, widget.initialValues ?? const {}, _locale!),
    );
    for (final MapEntry(:key, value: property) in _schema.properties.entries) {
      final node = FocusNode(debugLabel: key)
        ..addListener(() {
          if (!_focusNodes[key]!.hasFocus) _onLeave(key);
        });
      _focusNodes[key] = node;
      if (_textLike.contains(property.type)) {
        _controllers[key] = TextEditingController(
          text: (_state[key] as String?) ?? '',
        );
      }
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    for (final n in _focusNodes.values) {
      n.dispose();
    }
    super.dispose();
  }

  /// Leaving a field: mark it touched and tidy numbers for display.
  void _onLeave(String key) {
    final property = _schema.properties[key]!;
    final controller = _controllers[key];
    if (controller != null) {
      final text = controller.text;
      final tidy = switch (property.type) {
        FieldType.money => switch (parseMoneyInput(text)) {
          final String money => formatMoney(money, _locale!),
          null => null,
        },
        FieldType.number => switch (parseNumberInput(text)) {
          final num n => formatNumber(n, _locale!),
          null => null,
        },
        _ => null,
      };
      if (tidy != null && tidy != text) {
        controller.text = tidy;
        _state[key] = tidy;
      }
    }
    setState(() => _touched.add(key));
  }

  void _set(String key, Object? value, {bool touch = true}) {
    setState(() {
      _state[key] = value;
      if (touch) _touched.add(key);
    });
  }

  List<FieldIssue> get _issues =>
      formFieldIssues(_schema, formStateToValues(_schema, _state), _context);

  void _submit(AppLocalizations l10n) {
    final issues = _issues;
    setState(() => _submitted = true);
    if (issues.isEmpty) {
      widget.onSubmit(formStateToValues(_schema, _state));
      return;
    }
    final invalid = issues.map((i) => i.key).toSet();
    SemanticsService.sendAnnouncement(
      View.of(context),
      l10n.dynamicFormErrorSummary(
        invalid.length,
        localizeDigits('${invalid.length}', _locale!),
      ),
      Directionality.of(context),
    );
    final first = _schema.formFieldKeys.where(invalid.contains).firstOrNull;
    if (first != null) _focusNodes[first]?.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = _locale!;
    final values = formStateToValues(_schema, _state);
    final visible = visibleFields(_schema, values);
    final keys = _schema.formFieldKeys.where(visible.contains).toList();

    final errors = <String, String>{};
    for (final issue in _issues) {
      if (errors.containsKey(issue.key)) continue;
      if (!_submitted && !_touched.contains(issue.key)) continue;
      errors[issue.key] = describeIssue(l10n, _schema, issue, locale, _context);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final key in keys) ...[
          _field(key, l10n, locale, errors[key]),
          const SizedBox(height: AppSpacing.md),
        ],
        AppButton(
          label: widget.submitLabel ?? l10n.dynamicFormSubmit,
          onPressed: () => _submit(l10n),
        ),
      ],
    );
  }

  Widget _field(
    String key,
    AppLocalizations l10n,
    String locale,
    String? error,
  ) {
    final property = _schema.properties[key]!;
    final label = _schema.label(key, locale);
    final requiredLabel = _schema.isRequired(key)
        ? l10n.dynamicFormRequired
        : null;
    final options = [
      for (final code in property.options)
        AppSelectOption(code, _schema.optionLabel(key, code, locale)),
    ];

    Widget text({
      TextInputType? keyboardType,
      String? helper,
      String? prefix,
      int? maxLines = 1,
      int? minLines,
      int? maxLength,
      Iterable<String>? autofill,
    }) => AppTextField(
      label: label,
      controller: _controllers[key],
      focusNode: _focusNodes[key],
      keyboardType: keyboardType,
      helperText: helper,
      prefixText: prefix,
      maxLines: maxLines,
      minLines: minLines,
      maxLength: maxLength,
      autofillHints: autofill,
      requiredLabel: requiredLabel,
      errorText: error,
      textInputAction: maxLines == 1 ? TextInputAction.next : null,
      onChanged: (value) => _set(key, value, touch: false),
    );

    switch (property.type) {
      case FieldType.text:
        return text(
          keyboardType: property.format == 'uri' ? TextInputType.url : null,
          maxLength: property.maxLength,
        );
      case FieldType.textarea:
        return text(
          keyboardType: TextInputType.multiline,
          maxLines: 6,
          minLines: 3,
          maxLength: property.maxLength,
        );
      case FieldType.number:
        return text(
          keyboardType: property.integer
              ? TextInputType.number
              : const TextInputType.numberWithOptions(decimal: true),
        );
      case FieldType.money:
        return text(
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          prefix: '৳ ',
          helper: l10n.dynamicFormMoneyHint,
        );
      case FieldType.phone:
        return text(
          keyboardType: TextInputType.phone,
          helper: l10n.dynamicFormPhoneHint,
          autofill: const [AutofillHints.telephoneNumberNational],
        );
      case FieldType.date:
        final raw = _state[key] as String?;
        final today = DateTime.parse(_context.today);
        return AppDateField(
          label: label,
          value: raw == null ? null : DateTime.tryParse(raw),
          firstDate: property.notBeforeToday ? today : DateTime(1900),
          lastDate: DateTime(today.year + 10),
          format: (d) =>
              localizeDigits(DateFormat.yMMMMd(locale).format(d), locale),
          placeholder: l10n.dynamicFormPickDate,
          requiredLabel: requiredLabel,
          errorText: error,
          focusNode: _focusNodes[key],
          onChanged: (d) => _set(key, DateFormat('yyyy-MM-dd').format(d)),
        );
      case FieldType.bool:
        final value = _state[key] as bool?;
        if (requiredLabel != null) {
          // Required: an explicit yes/no, so "not answered" never looks like "no".
          return AppChoiceChips<bool>(
            label: label,
            options: [
              AppSelectOption(true, l10n.dynamicFormYes),
              AppSelectOption(false, l10n.dynamicFormNo),
            ],
            selected: {?value},
            requiredLabel: requiredLabel,
            errorText: error,
            onChanged: (s) => _set(key, s.firstOrNull),
          );
        }
        return AppSwitchTile(
          label: label,
          value: value ?? false,
          errorText: error,
          onChanged: (on) => _set(key, on),
        );
      case FieldType.select:
        final value = _state[key] as String?;
        if (options.length <= _chipSelectMaxOptions) {
          return AppChoiceChips<String>(
            label: label,
            options: options,
            selected: {?value},
            requiredLabel: requiredLabel,
            errorText: error,
            onChanged: (s) => _set(key, s.firstOrNull),
          );
        }
        return AppSelectField<String>(
          label: label,
          options: options,
          value: value,
          placeholder: l10n.dynamicFormChoose,
          requiredLabel: requiredLabel,
          errorText: error,
          focusNode: _focusNodes[key],
          onChanged: (v) => _set(key, v),
        );
      case FieldType.multiselect:
        final selected = List<String>.from((_state[key] as List?) ?? const []);
        return AppChoiceChips<String>(
          label: label,
          options: options,
          selected: selected.toSet(),
          multiple: true,
          requiredLabel: requiredLabel,
          errorText: error,
          // Keep schema order, whatever order they were tapped in.
          onChanged: (s) => _set(key, [
            for (final code in property.options)
              if (s.contains(code)) code,
          ]),
        );
    }
  }
}
