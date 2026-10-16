import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';
import '../application/agent_providers.dart';
import '../data/agent_capture_store.dart';
import '../data/agent_models.dart';
import 'agent_labels.dart';

/// The sync queue (ADR 066): every capture with where it stands — waiting
/// (and when it retries), synced, refused with the reason, or waiting for
/// the agent's answer to "already on the map?".
class AgentQueueScreen extends ConsumerWidget {
  const AgentQueueScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final queue = ref.watch(agentQueueProvider);
    final sync = ref.watch(agentSyncProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.agentQueue),
        actions: [
          IconButton(
            key: const ValueKey('queue-sync'),
            icon: const Icon(Icons.sync),
            tooltip: l10n.queueSyncNow,
            onPressed: () => unawaited(sync.syncAll()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: sync.syncAll,
        child: switch (queue) {
          AsyncData(:final value) when value.isEmpty => ListView(
            children: [
              EmptyState(
                title: l10n.queueEmpty,
                icon: Icons.cloud_done_outlined,
              ),
            ],
          ),
          AsyncData(:final value) => ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [for (final c in value) _CaptureTile(capture: c)],
          ),
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }
}

class _CaptureTile extends ConsumerWidget {
  const _CaptureTile({required this.capture});

  final AgentCapture capture;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final store = ref.read(agentCaptureStoreProvider);
    final sync = ref.read(agentSyncProvider);
    final colors = Theme.of(context).colorScheme;
    String time(DateTime t) =>
        localizeDigits(DateFormat.jm(locale).format(t), locale);

    final (icon, color, status) = switch (capture.state) {
      CaptureState.done => (
        Icons.cloud_done_outlined,
        Colors.green.shade700,
        l10n.queueDone,
      ),
      CaptureState.refused => (
        Icons.report_outlined,
        colors.error,
        l10n.queueRefused(
          AgentLabels.refusal(capture.errorCode, capture.errorReason, l10n),
        ),
      ),
      CaptureState.needsDecision => (
        Icons.help_outline,
        colors.tertiary,
        l10n.queueNeedsDecision,
      ),
      _ => (
        Icons.schedule,
        colors.outline,
        capture.nextAttemptAt == null
            ? l10n.queueQueued
            : l10n.queueRetryAt(time(capture.nextAttemptAt!)),
      ),
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        key: ValueKey('queue-${capture.id}'),
        padding: const EdgeInsets.all(AppSpacing.sm),
        onTap: capture.state == CaptureState.needsDecision
            ? () => _decide(context, ref)
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (capture.photoPaths.isNotEmpty &&
                    File(capture.photoPaths.first).existsSync())
                  ClipRRect(
                    borderRadius: BorderRadius.circular(AppSpacing.xs),
                    child: Image.file(
                      File(capture.photoPaths.first),
                      width: 56,
                      height: 56,
                      fit: BoxFit.cover,
                    ),
                  )
                else
                  Icon(icon, color: color, size: 40),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        capture.title,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      Text(
                        AgentLabels.taskType(_taskTypeOf(capture.kind), l10n),
                      ),
                      Text(status, style: TextStyle(color: color)),
                      if (capture.fraudFlags.isNotEmpty)
                        Text(
                          l10n.queueFlagged,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                    ],
                  ),
                ),
                Text(
                  time(capture.capturedAt),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
            if (capture.state == CaptureState.refused ||
                capture.state == CaptureState.queued)
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () async {
                      final ok = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          content: Text(l10n.queueDiscardConfirm),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.of(context).pop(true),
                              child: Text(l10n.queueDiscard),
                            ),
                          ],
                        ),
                      );
                      if (ok == true) await store.discard(capture.id);
                    },
                    child: Text(l10n.queueDiscard),
                  ),
                  TextButton(
                    onPressed: () async {
                      await store.retryNow(capture.id);
                      unawaited(sync.syncAll());
                    },
                    child: Text(l10n.queueSyncNow),
                  ),
                ],
              ),
            if (capture.state == CaptureState.needsDecision)
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  onPressed: () => _decide(context, ref),
                  child: Text(l10n.decisionTitle),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _taskTypeOf(String kind) => switch (kind) {
    'verify_shop' => 'verify_shop',
    'update_info' => 'update_info',
    _ => 'map_shop',
  };

  Future<void> _decide(BuildContext context, WidgetRef ref) async {
    final decision = await showModalBottomSheet<Map<String, Object?>>(
      context: context,
      isScrollControlled: true,
      builder: (_) => DecisionSheet(candidates: capture.candidates),
    );
    if (decision == null) return;
    await ref.read(agentCaptureStoreProvider).decide(capture.id, decision);
    unawaited(ref.read(agentSyncProvider).syncAll());
  }
}

/// "Is this shop already on the map?": one of these, or a different shop.
class DecisionSheet extends StatelessWidget {
  const DecisionSheet({required this.candidates, super.key});

  final List<DuplicateCandidate> candidates;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.decisionTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.sm),
            for (final c in candidates)
              Card(
                child: ListTile(
                  key: ValueKey('decision-same-${c.placeId}'),
                  leading: const Icon(Icons.storefront_outlined),
                  title: Text(c.nameBn),
                  subtitle: Text(
                    [
                      l10n.decisionDistance(
                        localizeDigits(c.distanceM.round().toString(), locale),
                      ),
                      if (c.phoneMatch) l10n.decisionPhoneMatch,
                    ].join(' · '),
                  ),
                  trailing: Text(l10n.decisionSame),
                  onTap: () => Navigator.of(
                    context,
                  ).pop({'decision': 'same', 'placeId': c.placeId}),
                ),
              ),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton(
              key: const ValueKey('decision-new'),
              onPressed: () => Navigator.of(context).pop({'decision': 'new'}),
              child: Text(l10n.decisionNew),
            ),
          ],
        ),
      ),
    );
  }
}
