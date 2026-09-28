import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/suggest_controller.dart';

/// What shows while the viewer is typing (or hasn't searched yet):
///
///  - nothing typed: their recent searches (this phone only) and this
///    area's trending searches as chips;
///  - something typed: matching categories, popular searches and listing
///    titles, in whichever script they typed.
class SuggestionsPanel extends ConsumerWidget {
  const SuggestionsPanel({
    required this.onQuery,
    required this.onCategory,
    required this.onListing,
    super.key,
  });

  /// A query to run as is (recent, trending, popular).
  final ValueChanged<String> onQuery;
  final ValueChanged<String> onCategory;
  final ValueChanged<String> onListing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suggest = ref.watch(suggestControllerProvider);
    return suggest.text.isEmpty
        ? _Starters(onQuery: onQuery)
        : _Typed(
            state: suggest,
            onQuery: onQuery,
            onCategory: onCategory,
            onListing: onListing,
          );
  }
}

class _Starters extends ConsumerWidget {
  const _Starters({required this.onQuery});

  final ValueChanged<String> onQuery;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final recent = ref.watch(recentSearchesProvider).value ?? const [];
    // Offline, or before anyone searched: no chips, nothing broken.
    final trending = ref.watch(trendingSearchesProvider).value ?? const [];
    return ListView(
      key: const ValueKey('search-starters'),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      children: [
        if (recent.isNotEmpty) ...[
          _SectionTitle(
            l10n.searchRecentTitle,
            action: TextButton(
              key: const ValueKey('search-recent-clear'),
              onPressed: () =>
                  ref.read(recentSearchesProvider.notifier).clear(),
              child: Text(l10n.searchRecentClear),
            ),
          ),
          for (final q in recent)
            ListTile(
              key: ValueKey('search-recent-$q'),
              leading: const Icon(Icons.history),
              title: Text(q),
              trailing: IconButton(
                tooltip: l10n.searchRecentRemove(q),
                icon: const Icon(Icons.close, size: 18),
                onPressed: () =>
                    ref.read(recentSearchesProvider.notifier).remove(q),
              ),
              onTap: () => onQuery(q),
            ),
        ],
        if (trending.isNotEmpty) ...[
          _SectionTitle(l10n.searchTrendingTitle),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                for (final q in trending)
                  ActionChip(
                    key: ValueKey('search-trending-$q'),
                    avatar: const Icon(Icons.trending_up, size: 18),
                    label: Text(q),
                    onPressed: () => onQuery(q),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _Typed extends StatelessWidget {
  const _Typed({
    required this.state,
    required this.onQuery,
    required this.onCategory,
    required this.onListing,
  });

  final SuggestState state;
  final ValueChanged<String> onQuery;
  final ValueChanged<String> onCategory;
  final ValueChanged<String> onListing;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final s = state.suggestions;
    return ListView(
      key: const ValueKey('search-suggestions'),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      children: [
        // Always first: search exactly what was typed.
        ListTile(
          key: const ValueKey('search-suggest-typed'),
          leading: const Icon(Icons.search),
          title: Text(state.text),
          onTap: () => onQuery(state.text),
        ),
        if (s.categories.isNotEmpty) ...[
          _SectionTitle(l10n.searchSuggestCategories),
          for (final c in s.categories)
            ListTile(
              key: ValueKey('search-suggest-category-${c.slug}'),
              leading: const Icon(Icons.category_outlined),
              title: Text(c.name.of(locale) ?? c.slug),
              onTap: () => onCategory(c.slug),
            ),
        ],
        if (s.queries.isNotEmpty) ...[
          _SectionTitle(l10n.searchSuggestQueries),
          for (final q in s.queries)
            ListTile(
              key: ValueKey('search-suggest-query-$q'),
              leading: const Icon(Icons.trending_up),
              title: Text(q),
              onTap: () => onQuery(q),
            ),
        ],
        if (s.listings.isNotEmpty) ...[
          _SectionTitle(l10n.searchSuggestListings),
          for (final listing in s.listings)
            ListTile(
              key: ValueKey('search-suggest-listing-${listing.id}'),
              leading: const Icon(Icons.sell_outlined),
              title: Text(
                listing.title.of(locale) ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              onTap: () => onListing(listing.id),
            ),
        ],
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, {this.action});

  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      AppSpacing.md,
      AppSpacing.sm,
      AppSpacing.sm,
      AppSpacing.xs,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        ?action,
      ],
    ),
  );
}
