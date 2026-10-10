import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';

/// "লিখছেন…" with three pulsing dots, at the foot of the thread.
class TypingIndicator extends StatefulWidget {
  const TypingIndicator({super.key});

  @override
  State<TypingIndicator> createState() => _TypingIndicatorState();
}

class _TypingIndicatorState extends State<TypingIndicator> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Container(
        key: const ValueKey('chat-typing'),
        margin: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: AppRadii.lgRadius),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++)
              FadeTransition(
                opacity: Tween<double>(begin: 0.3, end: 1).animate(
                  CurvedAnimation(parent: _controller, curve: Interval(i * 0.2, 0.6 + i * 0.2, curve: Curves.easeInOut)),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xxs),
                  child: CircleAvatar(radius: 3, backgroundColor: theme.colorScheme.onSurfaceVariant),
                ),
              ),
            const SizedBox(width: AppSpacing.sm),
            Text(l10n.chatTyping, style: theme.textTheme.labelMedium),
          ],
        ),
      ),
    );
  }
}
