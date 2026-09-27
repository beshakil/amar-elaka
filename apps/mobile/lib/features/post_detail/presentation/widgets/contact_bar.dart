import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';

/// The sticky bottom bar: Call · WhatsApp · Save · Share. The owner gets
/// their post's numbers instead of ways to contact themselves.
class ContactBar extends StatelessWidget {
  const ContactBar({
    required this.detail,
    required this.busy,
    required this.onCall,
    required this.onWhatsapp,
    required this.onToggleSaved,
    required this.onShare,
    super.key,
  });

  final PostDetail detail;

  /// A contact reveal is on its way: its button shows progress, others wait.
  final String? busy;
  final VoidCallback onCall;
  final VoidCallback onWhatsapp;
  final VoidCallback onToggleSaved;
  final VoidCallback onShare;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);

    if (detail.isMine) {
      final stats = detail.stats;
      return _BarFrame(
        child: Row(
          children: [
            Icon(Icons.person_outline, color: theme.colorScheme.primary),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                stats == null
                    ? l10n.detailOwnPost
                    : l10n.detailStats(
                        localizeDigits('${stats.views}', locale),
                        localizeDigits('${stats.contacts.total}', locale),
                        localizeDigits('${stats.saves}', locale),
                      ),
                key: const ValueKey('detail-own-stats'),
              ),
            ),
          ],
        ),
      );
    }

    final canCall = detail.contact.channels.contains('call') && !detail.isSold;
    final canWhatsapp =
        detail.contact.channels.contains('whatsapp') && !detail.isSold;
    return _BarFrame(
      child: Row(
        children: [
          Expanded(
            child: FilledButton.icon(
              key: const ValueKey('detail-call'),
              onPressed: canCall && busy == null ? onCall : null,
              icon: busy == 'call' ? const _Spinner() : const Icon(Icons.call),
              label: Text(l10n.detailCall),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: FilledButton.tonalIcon(
              key: const ValueKey('detail-whatsapp'),
              onPressed: canWhatsapp && busy == null ? onWhatsapp : null,
              icon: busy == 'whatsapp'
                  ? const _Spinner()
                  : const Icon(Icons.chat_outlined),
              label: Text(l10n.detailWhatsapp),
            ),
          ),
          const SizedBox(width: AppSpacing.xs),
          IconButton(
            key: const ValueKey('detail-save'),
            tooltip: detail.isSaved ? l10n.detailSaved : l10n.detailSave,
            isSelected: detail.isSaved,
            onPressed: onToggleSaved,
            icon: const Icon(Icons.favorite_border),
            selectedIcon: Icon(Icons.favorite, color: theme.colorScheme.error),
          ),
          IconButton(
            key: const ValueKey('detail-share'),
            tooltip: l10n.detailShare,
            onPressed: detail.share == null ? null : onShare,
            icon: const Icon(Icons.share_outlined),
          ),
        ],
      ),
    );
  }
}

class _BarFrame extends StatelessWidget {
  const _BarFrame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    // A hairline, not an elevation shadow: cheaper to paint on low-end phones.
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surface,
      border: Border(
        top: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
    ),
    child: SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          AppSpacing.sm,
          AppSpacing.sm,
          AppSpacing.sm,
        ),
        child: child,
      ),
    ),
  );
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const SizedBox.square(
    dimension: 18,
    child: CircularProgressIndicator(strokeWidth: 2),
  );
}
