import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';
import '../application/agent_providers.dart';
import '../data/agent_models.dart';
import 'agent_labels.dart';

/// My numbers (ADR 066): today and this week — submitted, approved,
/// rejected (with the reviewer's reason), pending — the target, and the
/// estimated commission (an estimate; payment is separate).
class AgentStatsScreen extends ConsumerWidget {
  const AgentStatsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final stats = ref.watch(agentStatsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.agentStats)),
      body: stats.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(agentStatsProvider),
        ),
        data: (s) => RefreshIndicator(
          onRefresh: () => ref.refresh(agentStatsProvider.future),
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              _Counts(
                title: l10n.statsToday,
                counts: s.today,
                target: s.targets.dailyShops,
                locale: locale,
              ),
              const SizedBox(height: AppSpacing.sm),
              _Counts(
                title: l10n.statsWeek,
                counts: s.week,
                target: s.targets.weeklyShops,
                locale: locale,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(
                l10n.statsCommissionNote,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.md),
              if (s.recent.isNotEmpty)
                Text(
                  l10n.statsRecent,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              for (final r in s.recent)
                ListTile(
                  key: ValueKey('outcome-${r.id}'),
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    r.reviewStatus == 'approved'
                        ? Icons.check_circle
                        : Icons.cancel,
                    color: r.reviewStatus == 'approved'
                        ? Colors.green.shade700
                        : Theme.of(context).colorScheme.error,
                  ),
                  title: Text(r.name ?? AgentLabels.taskType(r.kind, l10n)),
                  subtitle: r.reviewStatus == 'rejected'
                      ? Text(
                          l10n.statsReason(
                            [
                              AgentLabels.reason(r.reasonCode, l10n),
                              ?r.reasonText,
                            ].join(' — '),
                          ),
                        )
                      : null,
                  trailing: r.reviewStatus == 'approved'
                      ? Text('৳ ${formatMoney(r.commission, locale)}')
                      : null,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Counts extends StatelessWidget {
  const _Counts({
    required this.title,
    required this.counts,
    required this.target,
    required this.locale,
  });

  final String title;
  final OutcomeCounts counts;
  final int? target;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final text = Theme.of(context).textTheme;
    String n(int v) => localizeDigits('$v', locale);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: text.titleMedium),
          if (target != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l10n.statsTarget(n(counts.submitted), n(target!))),
                  LinearProgressIndicator(
                    value: target! == 0
                        ? 1
                        : (counts.submitted / target!).clamp(0, 1),
                  ),
                ],
              ),
            ),
          const SizedBox(height: AppSpacing.xs),
          Wrap(
            spacing: AppSpacing.md,
            runSpacing: AppSpacing.xs,
            children: [
              _Stat(label: l10n.statsSubmitted, value: n(counts.submitted)),
              _Stat(label: l10n.statsApproved, value: n(counts.approved)),
              _Stat(label: l10n.statsRejected, value: n(counts.rejected)),
              _Stat(label: l10n.statsPending, value: n(counts.pending)),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            l10n.statsCommission(formatMoney(counts.commission, locale)),
            style: text.titleSmall,
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(value, style: Theme.of(context).textTheme.headlineSmall),
      Text(label, style: Theme.of(context).textTheme.bodySmall),
    ],
  );
}
