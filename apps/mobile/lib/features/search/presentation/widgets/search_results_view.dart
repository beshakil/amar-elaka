import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/error_state.dart';
import '../../../../core/design/widgets/loading_shimmer.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../core/routing/auth_gate.dart';
import '../../../../core/routing/route_paths.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../feed/application/feed_controller.dart';
import '../../../feed/presentation/listing_format.dart';
import '../../../feed/presentation/widgets/post_listing_card.dart';
import '../../application/search_controller.dart';
import '../../domain/search_request.dart';
import '../search_labels.dart';
import 'search_empty_state.dart';
import 'search_filter_sheet.dart';

/// The results: count and radius, sort switcher, filter button, the active
/// filters as removable chips, "save this search", then the feed's own post
/// cards, paged as you scroll. Empty: [SearchEmptyState]'s ways forward.
class SearchResultsView extends ConsumerWidget {
  const SearchResultsView({
    required this.labels,
    required this.onSave,
    super.key,
  });

  final SearchLabels labels;
  final VoidCallback onSave;

  // Same prefetch as the feed: the next page is asked for this many cards early.
  static const _prefetchDistance = 6;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(searchControllerProvider);
    final controller = ref.read(searchControllerProvider.notifier);

    if (state.isEmpty) {
      return SearchEmptyState(
        state: state,
        labels: labels,
        onRemoveFilter: controller.removeFilter,
        onWiden: controller.widenRadius,
        onSave: onSave,
      );
    }
    return CustomScrollView(
      key: const ValueKey('search-results'),
      slivers: [
        SliverToBoxAdapter(
          child: _Header(state: state, labels: labels, onSave: onSave),
        ),
        if (state.result?.degraded ?? false)
          SliverToBoxAdapter(child: _Notice(l10n.searchDegradedBanner)),
        if (state.loading)
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            sliver: SliverList.separated(
              itemCount: 4,
              separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
              itemBuilder: (_, _) => const LoadingShimmer(
                height: PostListingCard.photoSize + AppSpacing.md,
              ),
            ),
          )
        else if (state.error != null)
          SliverFillRemaining(
            hasScrollBody: false,
            child: ErrorState(
              title: l10n.searchErrorTitle,
              message: state.error is ApiException
                  ? null
                  : l10n.searchErrorOfflineBody,
              retryLabel: l10n.genericRetry,
              onRetry: controller.retry,
            ),
          )
        else ...[
          if (state.result?.landmarks.isNotEmpty ?? false)
            SliverToBoxAdapter(
              child: _Landmarks(landmarks: state.result!.landmarks),
            ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            sliver: SliverList.separated(
              itemCount: state.hits.length,
              separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
              itemBuilder: (context, index) {
                if (index >= state.hits.length - _prefetchDistance) {
                  WidgetsBinding.instance.addPostFrameCallback(
                    (_) => controller.loadMore(),
                  );
                }
                final hit = state.hits[index];
                return PostListingCard(
                  key: ValueKey('search-result-${hit.id}'),
                  card: hit.toCard(isSaved: state.savedIds.contains(hit.id)),
                  onTap: () {
                    controller.opened(hit.id);
                    context.push(RoutePaths.postDetailFor(hit.id));
                  },
                  onToggleSaved: () => _toggleSaved(context, ref, hit.id),
                );
              },
            ),
          ),
          SliverToBoxAdapter(child: _ListEnd(state: state)),
        ],
      ],
    );
  }

  Future<void> _toggleSaved(
    BuildContext context,
    WidgetRef ref,
    String postId,
  ) async {
    if (!requireLogin(context, ref)) return;
    final messenger = ScaffoldMessenger.of(context);
    final message = AppLocalizations.of(context)!.feedSaveFailed;
    try {
      await ref.read(searchControllerProvider.notifier).toggleSaved(postId);
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(message)));
    }
  }
}

class _Header extends ConsumerWidget {
  const _Header({
    required this.state,
    required this.labels,
    required this.onSave,
  });

  final SearchState state;
  final SearchLabels labels;
  final VoidCallback onSave;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final controller = ref.read(searchControllerProvider.notifier);
    final request = state.request;
    final result = state.result;
    // Sorting by distance needs to know where the viewer is.
    final located = ref.watch(viewerPositionProvider).value != null;
    final filters = request.activeFilters;
    final summary = [
      if (result != null)
        l10n.searchResultCount(labels.count(result.totalHits)),
      if (result?.radiusKm case final km?)
        l10n.searchRadiusLabel(labels.km(km)),
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.sm,
        AppSpacing.md,
        AppSpacing.sm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  summary,
                  key: const ValueKey('search-summary'),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              PopupMenuButton<SearchSort>(
                key: const ValueKey('search-sort'),
                tooltip: l10n.searchSortLabel,
                initialValue: request.sort,
                onSelected: controller.setSort,
                itemBuilder: (_) => [
                  for (final sort in SearchSort.values)
                    if (sort != SearchSort.distance || located)
                      PopupMenuItem(
                        key: ValueKey('search-sort-${sort.api}'),
                        value: sort,
                        child: Text(labels.sort(sort)),
                      ),
                ],
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.sort, size: 18),
                      const SizedBox(width: AppSpacing.xs),
                      Text(labels.sort(request.sort)),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          SizedBox(
            height: 40,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                ActionChip(
                  key: const ValueKey('search-filter-button'),
                  avatar: const Icon(Icons.tune, size: 18),
                  label: Text(
                    filters.isEmpty
                        ? l10n.searchFilters
                        : l10n.searchFiltersCount(labels.count(filters.length)),
                  ),
                  // Facets come with results; offline or degraded there are none.
                  onPressed: result == null || result.degraded
                      ? null
                      : () => SearchFilterSheet.show(context),
                ),
                for (final filter in filters) ...[
                  const SizedBox(width: AppSpacing.sm),
                  InputChip(
                    label: Text(labels.filter(filter, request)),
                    deleteButtonTooltipMessage: l10n.searchFilterRemove(
                      labels.filter(filter, request),
                    ),
                    onDeleted: () => controller.removeFilter(filter),
                  ),
                ],
              ],
            ),
          ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton.icon(
              key: const ValueKey('search-save'),
              onPressed: onSave,
              icon: const Icon(Icons.notifications_none),
              label: Text(l10n.searchSaveButton),
            ),
          ),
        ],
      ),
    );
  }
}

class _Landmarks extends StatelessWidget {
  const _Landmarks({required this.landmarks});

  final List<SearchHit> landmarks;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.sm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.searchLandmarksTitle,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.xs),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: [
              for (final place in landmarks)
                Chip(
                  avatar: const Icon(Icons.place_outlined, size: 18),
                  label: Text(
                    [
                      place.name.of(locale) ?? '',
                      ?ListingFormat.distance(
                        place.distanceMeters,
                        l10n,
                        locale,
                      ),
                    ].join(' · '),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      key: const ValueKey('search-degraded'),
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.sm,
      ),
      padding: const EdgeInsets.all(AppSpacing.sm),
      color: colors.secondaryContainer,
      child: Text(text, style: TextStyle(color: colors.onSecondaryContainer)),
    );
  }
}

class _ListEnd extends ConsumerWidget {
  const _ListEnd({required this.state});

  final SearchState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (state.moreError != null) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          children: [
            Text(l10n.searchLoadMoreFailed),
            TextButton(
              onPressed: ref.read(searchControllerProvider.notifier).loadMore,
              child: Text(l10n.genericRetry),
            ),
          ],
        ),
      );
    }
    return const SizedBox(height: AppSpacing.xl);
  }
}
