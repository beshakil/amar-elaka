import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/map/base_map.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/current_tenant.dart';
import '../application/agent_providers.dart';
import '../data/agent_models.dart';
import 'agent_labels.dart';

/// Today's route (ADR 066): the assigned tasks on the map (open ones in the
/// brand colour, done ones grey) and as a list with done/remaining; a task
/// opens the capture for it.
class AgentTodayScreen extends ConsumerWidget {
  const AgentTodayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final today = ref.watch(agentTodayProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.agentToday)),
      body: today.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(agentTodayProvider),
        ),
        data: (t) => RefreshIndicator(
          onRefresh: () => ref.refresh(agentTodayProvider.future),
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Text(
                l10n.agentTodayDoneRemaining(
                  AgentLabels.digits(t.done, locale),
                  AgentLabels.digits(t.remaining, locale),
                ),
                key: const ValueKey('today-counts'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.sm),
              if (t.tasks.any((x) => x.lat != null)) _RouteMap(tasks: t.tasks),
              const SizedBox(height: AppSpacing.sm),
              if (t.tasks.isEmpty)
                EmptyState(title: l10n.todayEmpty, icon: Icons.route_outlined)
              else
                for (final task in t.tasks)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                    child: AppCard(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      onTap: task.done
                          ? null
                          : () => context.push(
                              RoutePaths.agentCapture,
                              extra: task,
                            ),
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          task.done
                              ? Icons.check_circle
                              : Icons.radio_button_unchecked,
                          color: task.done ? Colors.green.shade700 : null,
                        ),
                        title: Text(task.title),
                        subtitle: Text(
                          [
                            AgentLabels.taskType(task.type, l10n),
                            ?task.placeName,
                            ?task.localityName,
                          ].join(' · '),
                        ),
                        trailing: task.done
                            ? Text(l10n.taskDone)
                            : Text(l10n.taskStart),
                      ),
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RouteMap extends ConsumerWidget {
  const _RouteMap({required this.tasks});

  final List<AgentTask> tasks;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final located = [
      for (final t in tasks)
        if (t.lat != null && t.lng != null) t,
    ];
    final center = ref.watch(currentTenantConfigProvider)?.mapCenter;
    final lat =
        located.map((t) => t.lat!).fold<double>(0, (a, b) => a + b) /
        located.length;
    final lng =
        located.map((t) => t.lng!).fold<double>(0, (a, b) => a + b) /
        located.length;
    final primary = Theme.of(context).colorScheme.primary;
    String hex(Color c) =>
        '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';
    return SizedBox(
      height: 240,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppSpacing.sm),
        child: BaseMap(
          initialCenter: LatLng(
            located.isEmpty ? (center?.lat ?? 0) : lat,
            located.isEmpty ? (center?.lng ?? 0) : lng,
          ),
          initialZoom: 14,
          onStyleLoaded: (controller) async {
            for (final t in located) {
              await controller.addCircle(
                CircleOptions(
                  geometry: LatLng(t.lat!, t.lng!),
                  circleRadius: 9,
                  circleColor: t.done ? '#9e9e9e' : hex(primary),
                  circleStrokeColor: '#ffffff',
                  circleStrokeWidth: 2,
                ),
              );
            }
            if (located.length > 1) {
              final lats = located.map((t) => t.lat!);
              final lngs = located.map((t) => t.lng!);
              await controller.moveCamera(
                CameraUpdate.newLatLngBounds(
                  LatLngBounds(
                    southwest: LatLng(
                      lats.reduce(math.min),
                      lngs.reduce(math.min),
                    ),
                    northeast: LatLng(
                      lats.reduce(math.max),
                      lngs.reduce(math.max),
                    ),
                  ),
                  left: 40,
                  top: 40,
                  right: 40,
                  bottom: 40,
                ),
              );
            }
          },
        ),
      ),
    );
  }
}
