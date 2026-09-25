import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The single text input widget for the app — wraps `TextFormField` with
/// the app's decoration theme already applied via [Theme] (see `AppTheme`),
/// so call sites just supply content, not styling.
class AppTextField extends StatelessWidget {
  const AppTextField({
    required this.label,
    super.key,
    this.controller,
    this.hint,
    this.errorText,
    this.obscureText = false,
    this.keyboardType,
    this.prefixIcon,
    this.suffixIcon,
    this.enabled = true,
    this.autofocus = false,
    this.onChanged,
    this.textInputAction,
    this.inputFormatters,
    this.focusNode,
    this.helperText,
    this.prefixText,
    this.maxLines = 1,
    this.minLines,
    this.maxLength,
    this.requiredLabel,
    this.autofillHints,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final String? errorText;
  final bool obscureText;
  final TextInputType? keyboardType;
  final IconData? prefixIcon;
  final Widget? suffixIcon;
  final bool enabled;
  final bool autofocus;
  final ValueChanged<String>? onChanged;
  final TextInputAction? textInputAction;
  final List<TextInputFormatter>? inputFormatters;
  final FocusNode? focusNode;
  final String? helperText;

  /// Fixed text before the input (e.g. "৳"), not part of the value.
  final String? prefixText;
  final int? maxLines;
  final int? minLines;

  /// Caps input length and shows the counter.
  final int? maxLength;

  /// When set, the field is required: the label gets a visual "*" that
  /// screen readers announce as this text instead (e.g. "আবশ্যক").
  final String? requiredLabel;
  final Iterable<String>? autofillHints;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      obscureText: obscureText,
      keyboardType: keyboardType,
      enabled: enabled,
      autofocus: autofocus,
      onChanged: onChanged,
      textInputAction: textInputAction,
      inputFormatters: inputFormatters,
      focusNode: focusNode,
      maxLines: maxLines,
      minLines: minLines,
      maxLength: maxLength,
      autofillHints: autofillHints,
      decoration: InputDecoration(
        label: AppFieldLabel(label: label, requiredLabel: requiredLabel),
        hintText: hint,
        helperText: helperText,
        prefixText: prefixText,
        errorText: errorText,
        prefixIcon: prefixIcon == null ? null : Icon(prefixIcon),
        suffixIcon: suffixIcon,
      ),
    );
  }
}

/// A field label with an optional required marker: a visual "*" that
/// screen readers read as [requiredLabel] ("আবশ্যক") instead of "star".
class AppFieldLabel extends StatelessWidget {
  const AppFieldLabel({required this.label, super.key, this.requiredLabel});

  final String label;
  final String? requiredLabel;

  @override
  Widget build(BuildContext context) {
    final required = requiredLabel;
    return Text.rich(
      TextSpan(
        text: label,
        children: [
          if (required != null)
            TextSpan(
              text: ' *',
              semanticsLabel: ' ($required)',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
        ],
      ),
    );
  }
}
