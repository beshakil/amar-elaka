import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../l10n/app_localizations.dart';
import '../application/info_engine_providers.dart';
import 'info_card_tile.dart';

/// One filter of a list: its label and the query it adds.
typedef InfoFilter = ({String label, Map<String, String> query});

/// The engine's one list screen (ADR 065): a title, filter chips, the cards
/// near the viewer, pull to refresh, and an optional action — every type's
/// list is this screen with its own path and filters.
class InfoListScreen extends ConsumerStatefulWidget {
  const InfoListScreen({
    required this.title,
    required this.path,
    super.key,
    this.filters = const [],
    this.header,
    this.action,
    this.emptyIcon = Icons.info_outline,
  });

  final String title;
  final String path;
  final List<InfoFilter> filters;

  /// Above the list (e.g. "No power here?").
  final Widget? header;

  /// A floating action (post, report).
  final ({String label, IconData icon, VoidCallback onPressed})? action;
  final IconData emptyIcon;

  @override
  ConsumerState<InfoListScreen> createState() => _InfoListScreenState();
}

class _InfoListScreenState extends ConsumerState<InfoListScreen> {
  int _filter = 0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final query = widget.filters.isEmpty
        ? const <String, String>{}
        : widget.filters[_filter].query;
    final key = infoList(widget.path, query);
    final cards = ref.watch(infoListProvider(key));
    final action = widget.action;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      floatingActionButton: action == null
          ? null
          : FloatingActionButton.extended(
              onPressed: action.onPressed,
              icon: Icon(action.icon),
              label: Text(action.label),
            ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(infoListProvider(key).future),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.sm,
            AppSpacing.md,
            AppSpacing.xxl * 2,
          ),
          children: [
            ?widget.header,
            if (widget.filters.length > 1)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Wrap(
                  spacing: AppSpacing.xs,
                  runSpacing: AppSpacing.xs,
                  children: [
                    for (final (i, f) in widget.filters.indexed)
                      ChoiceChip(
                        label: Text(f.label),
                        selected: i == _filter,
                        onSelected: (_) => setState(() => _filter = i),
                      ),
                  ],
                ),
              ),
            ...cards.when(
              loading: () => [
                const Padding(
                  padding: EdgeInsets.all(AppSpacing.xl),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ],
              error: (_, _) => [
                ErrorState(
                  title: l10n.errorGenericTitle,
                  retryLabel: l10n.genericRetry,
                  onRetry: () => ref.invalidate(infoListProvider(key)),
                ),
              ],
              data: (items) => items.isEmpty
                  ? [EmptyState(title: l10n.infoEmpty, icon: widget.emptyIcon)]
                  : [for (final c in items) InfoCardTile(card: c)],
            ),
          ],
        ),
      ),
    );
  }
}
