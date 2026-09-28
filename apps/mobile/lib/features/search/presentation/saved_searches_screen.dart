import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/presentation/widgets/post_listing_card.dart';
import '../../post/application/post_editor.dart';
import '../application/saved_searches_controller.dart';
import 'search_labels.dart';

/// The user's saved searches (ADR 041): each with its new-result badge, how
/// it notifies, and whether it's on — switched off, or auto-paused for not
/// being opened. Tap: its new results. Swipe or menu: pause/resume, delete.
class SavedSearchesScreen extends ConsumerWidget {
  const SavedSearchesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final list = ref.watch(savedSearchesProvider);
    final labels = SearchLabels(
      l10n,
      locale,
      ref.watch(postableCategoriesProvider).value ?? const [],
    );

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.savedSearchesTitle),
        actions: [
          if (list.value case final loaded?)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.md),
              child: Center(
                child: Text(
                  l10n.savedSearchesActive(
                    labels.count(loaded.activeCount),
                    labels.count(loaded.maxActive),
                  ),
                  key: const ValueKey('saved-searches-active'),
                ),
              ),
            ),
        ],
      ),
      body: switch (list) {
        AsyncData(:final value) when value.items.isEmpty => EmptyState(
          title: l10n.savedSearchesEmptyTitle,
          message: l10n.savedSearchesEmptyBody,
          icon: Icons.bookmarks_outlined,
        ),
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(savedSearchesProvider.future),
          child: ListView.separated(
            key: const ValueKey('saved-searches-list'),
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            itemCount: value.items.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, i) =>
                _SavedSearchTile(search: value.items[i], labels: labels),
          ),
        ),
        AsyncError() => ErrorState(
          title: l10n.savedSearchesErrorTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(savedSearchesProvider),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _SavedSearchTile extends ConsumerWidget {
  const _SavedSearchTile({required this.search, required this.labels});

  final SavedSearch search;
  final SearchLabels labels;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final details = [
      if (search.q.isNotEmpty) '“${search.q}”',
      if (search.filters.category case final slug?) labels.categoryName(slug),
      if (search.filters.priceMin != null || search.filters.priceMax != null)
        labels.priceRange(search.filters.priceMin, search.filters.priceMax),
      l10n.searchRadiusLabel(labels.km(search.radiusKm)),
    ].join(' · ');
    final status = search.active
        ? labels.frequency(search.frequency)
        : search.pausedAt != null
        ? l10n.savedSearchAutoPaused
        : l10n.savedSearchPaused;

    return ListTile(
      key: ValueKey('saved-search-${search.id}'),
      onTap: () => context.push(RoutePaths.savedSearchFor(search.id)),
      leading: Badge(
        key: ValueKey('saved-search-badge-${search.id}'),
        isLabelVisible: search.newResultCount > 0,
        label: Text(labels.count(search.newResultCount)),
        child: Icon(
          search.active
              ? Icons.notifications_active_outlined
              : Icons.notifications_off_outlined,
          color: search.active
              ? theme.colorScheme.primary
              : theme.colorScheme.onSurfaceVariant,
        ),
      ),
      title: Text(search.name),
      subtitle: Text(
        '$details\n$status',
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      ),
      isThreeLine: true,
      trailing: PopupMenuButton<String>(
        key: ValueKey('saved-search-menu-${search.id}'),
        onSelected: (action) => _act(context, ref, action),
        itemBuilder: (_) => [
          PopupMenuItem(
            key: ValueKey('saved-search-toggle-${search.id}'),
            value: 'toggle',
            child: Text(
              search.active ? l10n.savedSearchPause : l10n.savedSearchResume,
            ),
          ),
          PopupMenuItem(
            key: ValueKey('saved-search-delete-${search.id}'),
            value: 'delete',
            child: Text(l10n.savedSearchDelete),
          ),
        ],
      ),
    );
  }

  Future<void> _act(BuildContext context, WidgetRef ref, String action) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final controller = ref.read(savedSearchesProvider.notifier);
    try {
      if (action == 'toggle') {
        await controller.setActive(search.id, active: !search.active);
      } else {
        final confirmed = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(l10n.savedSearchDeleteTitle(search.name)),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: Text(l10n.savedSearchCancel),
              ),
              TextButton(
                key: const ValueKey('saved-search-delete-confirm'),
                onPressed: () => Navigator.of(context).pop(true),
                child: Text(l10n.savedSearchDelete),
              ),
            ],
          ),
        );
        if (confirmed ?? false) await controller.delete(search.id);
      }
    } on AppException catch (error) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(switch (error) {
            ApiException(code: 'SAVED_SEARCH_LIMIT_REACHED', :final body) =>
              l10n.searchSaveLimit(
                labels.count(
                  (body.details as Map<String, dynamic>?)?['maxActive']
                          as int? ??
                      0,
                ),
              ),
            _ => l10n.savedSearchActionFailed,
          }),
        ),
      );
    }
  }
}

/// One saved search's new results (the notification's deep link,
/// `/saved-searches/:id`). Opening them marks them seen.
class SavedSearchResultsScreen extends ConsumerWidget {
  const SavedSearchResultsScreen({required this.id, super.key});

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final results = ref.watch(savedSearchNewResultsProvider(id));
    // Seen now: the list's badges are stale.
    ref.listen(savedSearchNewResultsProvider(id), (_, next) {
      if (next.hasValue) ref.invalidate(savedSearchesProvider);
    });

    return Scaffold(
      appBar: AppBar(
        title: Text(
          results.value?.search.name ?? l10n.savedSearchNewResultsTitle,
        ),
      ),
      body: switch (results) {
        AsyncData(:final value) when value.results.isEmpty => EmptyState(
          title: l10n.savedSearchNoNewResults,
          icon: Icons.notifications_none,
        ),
        AsyncData(:final value) => ListView.separated(
          key: const ValueKey('saved-search-results'),
          padding: const EdgeInsets.all(AppSpacing.md),
          itemCount: value.results.length,
          separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
          itemBuilder: (context, i) {
            final card = value.results[i];
            return PostListingCard(
              key: ValueKey('saved-search-result-${card.id}'),
              card: card,
              onTap: () => context.push(RoutePaths.postDetailFor(card.id)),
            );
          },
        ),
        AsyncError() => ErrorState(
          title: l10n.savedSearchesErrorTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(savedSearchNewResultsProvider(id)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}
