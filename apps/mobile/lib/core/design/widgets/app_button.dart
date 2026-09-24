import 'package:flutter/material.dart';

import '../tokens/app_spacing.dart';

enum AppButtonVariant { primary, secondary, text }

/// The single button widget for the app — variant + optional loading state,
/// instead of choosing between `ElevatedButton`/`OutlinedButton`/`TextButton`
/// at each call site.
class AppButton extends StatelessWidget {
  const AppButton({
    required this.label,
    required this.onPressed,
    super.key,
    this.variant = AppButtonVariant.primary,
    this.isLoading = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final AppButtonVariant variant;
  final bool isLoading;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final onTap = isLoading ? null : onPressed;
    final child = isLoading
        ? SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: _foreground(context),
            ),
          )
        : _Label(label: label, icon: icon);

    return switch (variant) {
      AppButtonVariant.primary => ElevatedButton(
        onPressed: onTap,
        child: child,
      ),
      AppButtonVariant.secondary => OutlinedButton(
        onPressed: onTap,
        child: child,
      ),
      AppButtonVariant.text => TextButton(onPressed: onTap, child: child),
    };
  }

  Color? _foreground(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return variant == AppButtonVariant.primary
        ? scheme.onPrimary
        : scheme.primary;
  }
}

class _Label extends StatelessWidget {
  const _Label({required this.label, this.icon});

  final String label;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    if (icon == null) return Text(label);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 18),
        const SizedBox(width: AppSpacing.xs),
        Text(label),
      ],
    );
  }
}
