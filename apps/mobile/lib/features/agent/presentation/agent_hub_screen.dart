import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/agent_providers.dart';
import '../data/agent_capture_store.dart';
import 'agent_labels.dart';

/// Agent mode's home (ADR 066): add a shop, today's route, the sync queue
/// (what waits, what needs an answer), my numbers. Works offline from the
/// kept bootstrap.
class AgentHubScreen extends ConsumerWidget {
  const AgentHubScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final bootstrap = ref.watch(agentBootstrapProvider);
    final queue = ref.watch(agentQueueProvider).value ?? const [];
    // Keep the sync engine alive while agent mode is open.
    ref.watch(agentSyncProvider);
    final waiting = queue.where((c) => c.state == CaptureState.queued).length;
    final decisions = queue
        .where((c) => c.state == CaptureState.needsDecision)
        .length;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.agentHubTitle)),
      body: bootstrap.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(agentBootstrapProvider),
        ),
        data: (b) => b == null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  child: Text(l10n.agentNotAgent, textAlign: TextAlign.center),
                ),
              )
            : ListView(
                padding: const EdgeInsets.all(AppSpacing.md),
                children: [
                  if (b.fromCache)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                      child: Text(l10n.agentOfflineCopy),
                    ),
                  Text(
                    l10n.agentHubCode(b.me.code),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  FilledButton.icon(
                    key: const ValueKey('agent-capture'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(56),
                    ),
                    icon: const Icon(Icons.add_business_outlined),
                    label: Text(l10n.agentCaptureNew),
                    onPressed: () => context.push(RoutePaths.agentCapture),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  _Tile(
                    icon: Icons.route_outlined,
                    title: l10n.agentToday,
                    onTap: () => context.push(RoutePaths.agentToday),
                  ),
                  _Tile(
                    icon: Icons.cloud_upload_outlined,
                    title: l10n.agentQueue,
                    subtitle: [
                      if (waiting > 0)
                        l10n.agentQueueWaiting(
                          AgentLabels.digits(waiting, locale),
                        ),
                      if (decisions > 0)
                        l10n.agentQueueDecisions(
                          AgentLabels.digits(decisions, locale),
                        ),
                    ].join(' · '),
                    badge: decisions > 0,
                    onTap: () => context.push(RoutePaths.agentQueue),
                  ),
                  _Tile(
                    icon: Icons.insights_outlined,
                    title: l10n.agentStats,
                    onTap: () => context.push(RoutePaths.agentStats),
                  ),
                ],
              ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.icon,
    required this.title,
    required this.onTap,
    this.subtitle = '',
    this.badge = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
    child: AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(AppSpacing.sm),
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Badge(isLabelVisible: badge, child: Icon(icon, size: 32)),
        title: Text(title),
        subtitle: subtitle.isEmpty ? null : Text(subtitle),
        trailing: const Icon(Icons.chevron_right),
      ),
    ),
  );
}
