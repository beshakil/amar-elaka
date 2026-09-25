import 'package:flutter/material.dart';

import '../tokens/app_spacing.dart';
import '../tokens/app_typography.dart';
import 'app_bottom_sheet.dart';
import 'app_chip.dart';
import 'app_text_field.dart';

/// Form controls beyond [AppTextField]: a switch row, a select opened in a
/// bottom sheet, a date field, a chip group and a min–max range. Like the
/// other design-system widgets they only take content; styling comes from
/// the theme. Each one exposes its label, required state and error to
/// screen readers, and announces a newly shown error (live region).

/// An error line under a control; a live region, so a new error is read out.
class AppFieldError extends StatelessWidget {
  const AppFieldError(this.text, {super.key});

  final String? text;

  @override
  Widget build(BuildContext context) {
    final message = text;
    if (message == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xs),
      child: Semantics(
        liveRegion: true,
        child: Text(
          message,
          style: AppTypography.bodySmall.copyWith(
            color: Theme.of(context).colorScheme.error,
          ),
        ),
      ),
    );
  }
}

/// A labelled on/off row; the whole row toggles and is one semantic switch.
class AppSwitchTile extends StatelessWidget {
  const AppSwitchTile({
    required this.label,
    required this.value,
    required this.onChanged,
    super.key,
    this.errorText,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        MergeSemantics(
          child: InkWell(
            onTap: () => onChanged(!value),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
              child: Row(
                children: [
                  Expanded(child: Text(label, style: AppTypography.bodyLarge)),
                  Switch(value: value, onChanged: onChanged),
                ],
              ),
            ),
          ),
        ),
        AppFieldError(errorText),
      ],
    );
  }
}

class AppSelectOption<T> {
  const AppSelectOption(this.value, this.label);

  final T value;
  final String label;
}

/// A tappable field that opens the options in an [AppBottomSheet].
class AppSelectField<T> extends StatelessWidget {
  const AppSelectField({
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
    required this.placeholder,
    super.key,
    this.errorText,
    this.requiredLabel,
    this.focusNode,
  });

  final String label;
  final List<AppSelectOption<T>> options;
  final T? value;
  final ValueChanged<T> onChanged;
  final String placeholder;
  final String? errorText;
  final String? requiredLabel;
  final FocusNode? focusNode;

  Future<void> _open(BuildContext context) async {
    final picked = await AppBottomSheet.show<T>(
      context,
      isScrollControlled: true,
      builder: (sheetContext) => Flexible(
        child: ListView(
          shrinkWrap: true,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Semantics(
                header: true,
                child: Text(label, style: AppTypography.titleMedium),
              ),
            ),
            for (final option in options)
              ListTile(
                title: Text(option.label),
                selected: option.value == value,
                trailing: option.value == value
                    ? const Icon(Icons.check)
                    : null,
                onTap: () => Navigator.of(sheetContext).pop(option.value),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    final selected = options.where((o) => o.value == value).firstOrNull;
    return Semantics(
      button: true,
      child: InkWell(
        focusNode: focusNode,
        onTap: () => _open(context),
        child: InputDecorator(
          isEmpty: selected == null,
          decoration: InputDecoration(
            label: AppFieldLabel(label: label, requiredLabel: requiredLabel),
            hintText: placeholder,
            errorText: errorText,
            suffixIcon: const Icon(Icons.arrow_drop_down),
          ),
          child: selected == null ? null : Text(selected.label),
        ),
      ),
    );
  }
}

/// A date field that opens the platform date picker. [format] renders the
/// chosen day (e.g. with Bengali digits).
class AppDateField extends StatelessWidget {
  const AppDateField({
    required this.label,
    required this.value,
    required this.onChanged,
    required this.format,
    required this.firstDate,
    required this.lastDate,
    required this.placeholder,
    super.key,
    this.errorText,
    this.requiredLabel,
    this.focusNode,
  });

  final String label;
  final DateTime? value;
  final ValueChanged<DateTime> onChanged;
  final String Function(DateTime) format;
  final DateTime firstDate;
  final DateTime lastDate;
  final String placeholder;
  final String? errorText;
  final String? requiredLabel;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final current = value;
    return Semantics(
      button: true,
      child: InkWell(
        focusNode: focusNode,
        onTap: () async {
          final picked = await showDatePicker(
            context: context,
            initialDate: current ?? firstDate,
            firstDate: firstDate,
            lastDate: lastDate,
          );
          if (picked != null) onChanged(picked);
        },
        child: InputDecorator(
          isEmpty: current == null,
          decoration: InputDecoration(
            label: AppFieldLabel(label: label, requiredLabel: requiredLabel),
            hintText: placeholder,
            errorText: errorText,
            suffixIcon: const Icon(Icons.calendar_today_outlined),
          ),
          child: current == null ? null : Text(format(current)),
        ),
      ),
    );
  }
}

/// A labelled group of [AppChip]s: single choice (radio-like) or multiple.
/// The group is one semantic container named by its label.
class AppChoiceChips<T> extends StatelessWidget {
  const AppChoiceChips({
    required this.label,
    required this.options,
    required this.selected,
    required this.onChanged,
    super.key,
    this.multiple = false,
    this.errorText,
    this.requiredLabel,
  });

  final String label;
  final List<AppSelectOption<T>> options;
  final Set<T> selected;
  final ValueChanged<Set<T>> onChanged;
  final bool multiple;
  final String? errorText;
  final String? requiredLabel;

  void _toggle(T value, bool on) {
    if (multiple) {
      onChanged(on ? {...selected, value} : ({...selected}..remove(value)));
    } else {
      onChanged(on ? {value} : {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      explicitChildNodes: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DefaultTextStyle.merge(
            style: AppTypography.labelLarge,
            child: AppFieldLabel(label: label, requiredLabel: requiredLabel),
          ),
          const SizedBox(height: AppSpacing.xs),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: [
              for (final option in options)
                Semantics(
                  inMutuallyExclusiveGroup: !multiple,
                  child: AppChip(
                    label: option.label,
                    selected: selected.contains(option.value),
                    onSelected: (on) => _toggle(option.value, on),
                  ),
                ),
            ],
          ),
          AppFieldError(errorText),
        ],
      ),
    );
  }
}

/// A min–max pair of inputs under one label (filters).
class AppRangeField extends StatelessWidget {
  const AppRangeField({
    required this.label,
    required this.minLabel,
    required this.maxLabel,
    required this.minController,
    required this.maxController,
    super.key,
    this.keyboardType,
    this.prefixText,
    this.onChanged,
    this.minFocusNode,
    this.maxFocusNode,
    this.minError = false,
    this.maxError = false,
    this.errorText,
  });

  final String label;
  final String minLabel;
  final String maxLabel;
  final TextEditingController minController;
  final TextEditingController maxController;
  final TextInputType? keyboardType;
  final String? prefixText;
  final VoidCallback? onChanged;
  final FocusNode? minFocusNode;
  final FocusNode? maxFocusNode;
  final bool minError;
  final bool maxError;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    Widget bound(
      String boundLabel,
      TextEditingController controller,
      FocusNode? focusNode,
      bool hasError,
    ) {
      return Expanded(
        child: TextField(
          controller: controller,
          focusNode: focusNode,
          keyboardType: keyboardType,
          onChanged: (_) => onChanged?.call(),
          decoration: InputDecoration(
            labelText: boundLabel,
            prefixText: prefixText,
            // A red border without text; the shared error line explains it.
            errorText: hasError ? '' : null,
            errorStyle: const TextStyle(height: 0, fontSize: 0),
          ),
        ),
      );
    }

    return Semantics(
      container: true,
      label: label,
      explicitChildNodes: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: AppTypography.labelLarge),
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              bound(minLabel, minController, minFocusNode, minError),
              const SizedBox(width: AppSpacing.sm),
              bound(maxLabel, maxController, maxFocusNode, maxError),
            ],
          ),
          AppFieldError(errorText),
        ],
      ),
    );
  }
}
