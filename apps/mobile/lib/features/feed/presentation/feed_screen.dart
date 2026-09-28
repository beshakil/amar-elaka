import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/loading_shimmer.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/dynamic_form/field_schema.dart';
import '../../../core/dynamic_form/filters.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/post_editor.dart';
import '../application/feed_controller.dart';
import '../domain/feed_query.dart';
import 'widgets/feed_filter_sheet.dart';
import 'widgets/feed_info_cards.dart';
import 'widgets/post_listing_card.dart';

/// The home feed (ADR 038): scope switcher, category chips and the
/// category's filter sheet on top; below, ranked post cards mixed with store
/// and info cards, paged by cursor as you scroll, pull to refresh. Offline
/// it shows the last feed it saw, with a banner — never a blank screen.
class FeedScreen extends ConsumerWidget {
  const FeedScreen({super.key});

  // How close to the end (in items) the next page is asked for: early
  // enough that a normal fling never reaches an empty bottom.
  static const _prefetchDistance = 6;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(feedControllerProvider);
    final controller = ref.read(feedControllerProvider.notifier);
    final l10n = AppLocalizations.of(context)!;

    return RefreshIndicator(
      onRefresh: controller.refresh,
      child: CustomScrollView(
        key: const PageStorageKey('feed'),
        slivers: [
          SliverToBoxAdapter(child: _FeedHeader(query: state.query)),
          if (state.isOffline)
            SliverToBoxAdapter(
              child: _OfflineNotice(cachedAt: state.cachedAt!),
            ),
          if (state.loading)
            const _LoadingList()
          else if (state.error != null)
            SliverFillRemaining(
              hasScrollBody: false,
              child: ErrorState(
                title: l10n.feedErrorTitle,
                message: state.error is ApiException
                    ? null
                    : l10n.feedErrorOfflineBody,
                retryLabel: l10n.feedRetry,
                onRetry: controller.refresh,
              ),
            )
          else if (state.items.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: EmptyState(
                title: l10n.feedEmptyTitle,
                message: l10n.feedEmptyBody,
                icon: Icons.search_off_outlined,
              ),
            )
          else ...[
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              sliver: SliverList.separated(
                itemCount: state.items.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.sm),
                itemBuilder: (context, index) {
                  if (index >= state.items.length - _prefetchDistance) {
                    // After this frame: never change state while building.
                    WidgetsBinding.instance.addPostFrameCallback(
                      (_) => controller.loadMore(),
                    );
                  }
                  return _FeedItemView(item: state.items[index]);
                },
              ),
            ),
            SliverToBoxAdapter(child: _ListEnd(state: state)),
          ],
        ],
      ),
    );
  }
}

class _FeedItemView extends ConsumerWidget {
  const _FeedItemView({required this.item});

  final FeedItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (item) {
    FeedPostCard() => PostListingCard(
      key: ValueKey('feed-post-${(item as FeedPostCard).id}'),
      card: item as FeedPostCard,
      onTap: () =>
          context.push(RoutePaths.postDetailFor((item as FeedPostCard).id)),
      onToggleSaved: () =>
          _toggleSaved(context, ref, (item as FeedPostCard).id),
    ),
    final FeedStoreCard store => StoreListingCard(card: store),
    final FeedLandmarkCard landmark => LandmarkListingCard(card: landmark),
    final FeedBazarCard bazar => BazarPricesCard(card: bazar),
    final FeedEmergencyCard emergency => EmergencyCard(card: emergency),
  };

  Future<void> _toggleSaved(
    BuildContext context,
    WidgetRef ref,
    String postId,
  ) async {
    if (!requireLogin(context, ref)) return;
    final messenger = ScaffoldMessenger.of(context);
    final message = AppLocalizations.of(context)!.feedSaveFailed;
    try {
      await ref.read(feedControllerProvider.notifier).toggleSaved(postId);
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(message)));
    }
  }
}

/// Scope switcher and category chips (with the filter button).
class _FeedHeader extends ConsumerWidget {
  const _FeedHeader({required this.query});

  final FeedQuery query;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final controller = ref.read(feedControllerProvider.notifier);
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
          // Looks like a search bar; opens search, where typing happens.
          Material(
            color: Theme.of(context).colorScheme.surfaceContainerHigh,
            shape: const StadiumBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              key: const ValueKey('feed-search'),
              onTap: () => context.push(RoutePaths.search),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.md,
                  vertical: AppSpacing.sm + AppSpacing.xs,
                ),
                child: Row(
                  children: [
                    const Icon(Icons.search),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        l10n.searchBarHint,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          SegmentedButton<FeedScope>(
            key: const ValueKey('feed-scope'),
            showSelectedIcon: false,
            segments: [
              ButtonSegment(
                value: FeedScope.area,
                label: Text(l10n.feedScopeArea),
              ),
              ButtonSegment(
                value: FeedScope.nearby,
                label: Text(l10n.feedScopeNearby),
              ),
              ButtonSegment(
                value: FeedScope.country,
                label: Text(l10n.feedScopeCountry),
              ),
            ],
            selected: {query.scope},
            onSelectionChanged: (selected) =>
                controller.setScope(selected.first),
          ),
          const SizedBox(height: AppSpacing.sm),
          _CategoryChips(query: query),
        ],
      ),
    );
  }
}

class _CategoryChips extends ConsumerWidget {
  const _CategoryChips({required this.query});

  final FeedQuery query;

  static const _height = 40.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final controller = ref.read(feedControllerProvider.notifier);
    // Offline without categories: the feed still shows; the chips wait.
    final categories = ref.watch(postableCategoriesProvider).value ?? const [];
    if (categories.isEmpty) return const SizedBox.shrink();

    final selected = categories
        .where((c) => c.slug == query.categorySlug)
        .firstOrNull;
    final schema = selected?.fieldSchema == null
        ? null
        : CategoryFieldSchema.fromJson(selected!.fieldSchema!);
    final canFilter = schema != null && filterFieldKeys(schema).isNotEmpty;
    final active = schema == null
        ? 0
        : activeFilterCount(schema, query.filterState);

    return SizedBox(
      height: _height,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          if (canFilter) ...[
            ActionChip(
              key: const ValueKey('feed-filter-button'),
              avatar: const Icon(Icons.tune, size: 18),
              label: Text(
                active == 0
                    ? l10n.feedFilters
                    : l10n.feedFiltersCount(localizeDigits('$active', locale)),
              ),
              onPressed: () async {
                final applied = await FeedFilterSheet.show(
                  context,
                  categoryName: selected!.name.of(locale),
                  schema: schema,
                  initialState: query.filterState,
                );
                if (applied != null) {
                  await controller.setFilters(applied.state, applied.filters);
                }
              },
            ),
            const SizedBox(width: AppSpacing.sm),
          ],
          ChoiceChip(
            label: Text(l10n.feedAllCategories),
            selected: query.categorySlug == null,
            onSelected: (_) => controller.setCategory(null),
          ),
          for (final category in categories) ...[
            const SizedBox(width: AppSpacing.sm),
            ChoiceChip(
              key: ValueKey('feed-category-${category.slug}'),
              label: Text(category.name.of(locale)),
              selected: query.categorySlug == category.slug,
              onSelected: (_) => controller.setCategory(
                query.categorySlug == category.slug ? null : category.slug,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _OfflineNotice extends StatelessWidget {
  const _OfflineNotice({required this.cachedAt});

  final DateTime cachedAt;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    final local = cachedAt.toLocal();
    final time = localizeDigits(
      '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}',
      locale,
    );
    return Container(
      key: const ValueKey('feed-offline-banner'),
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.sm,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colors.tertiaryContainer,
        borderRadius: BorderRadius.circular(AppSpacing.sm),
      ),
      child: Row(
        children: [
          Icon(
            Icons.cloud_off_outlined,
            size: 18,
            color: colors.onTertiaryContainer,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              l10n.feedOfflineBanner(time),
              style: TextStyle(color: colors.onTertiaryContainer),
            ),
          ),
        ],
      ),
    );
  }
}

class _LoadingList extends StatelessWidget {
  const _LoadingList();

  static const _placeholders = 5;

  @override
  Widget build(BuildContext context) => SliverPadding(
    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
    sliver: SliverList.separated(
      itemCount: _placeholders,
      separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
      itemBuilder: (_, _) => const LoadingShimmer(
        height: PostListingCard.photoSize + AppSpacing.md,
      ),
    ),
  );
}

/// The list's end: the next page loading, its retry, or nothing.
class _ListEnd extends ConsumerWidget {
  const _ListEnd({required this.state});

  final FeedState state;

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
            Text(l10n.feedLoadMoreFailed),
            TextButton(
              onPressed: ref.read(feedControllerProvider.notifier).loadMore,
              child: Text(l10n.feedRetry),
            ),
          ],
        ),
      );
    }
    return const SizedBox(height: AppSpacing.xl);
  }
}
