import 'package:flutter/material.dart';

import '../tokens/app_spacing.dart';

/// Consistent card padding/shape (via `AppTheme.cardTheme`) — an optional
/// [onTap] turns it into a pressable surface with the right ink response.
class AppCard extends StatelessWidget {
  const AppCard({
    required this.child,
    super.key,
    this.onTap,
    this.padding = const EdgeInsets.all(AppSpacing.md),
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).cardTheme;
    return Material(
      color: theme.color,
      shape: theme.shape,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}
