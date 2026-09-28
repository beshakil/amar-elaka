import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/search_controller.dart';
import '../../domain/search_request.dart';
import '../search_labels.dart';

/// No results — and a way forward, never a dead end. In order of how likely
/// each is to help:
///
///  1. search without one of the filters (each active filter, by name);
///  2. search a wider radius (twice the one used), until the server's
///     maximum;
///  3. save the search, to be told when something appears.
class SearchEmptyState extends StatelessWidget {
  const SearchEmptyState({
    required this.state,
    required this.labels,
    required this.onRemoveFilter,
    required this.onWiden,
    required this.onSave,
    super.key,
  });

  final SearchState state;
  final SearchLabels labels;
  final ValueChanged<ActiveFilter> onRemoveFilter;
  final VoidCallback onWiden;
  final VoidCallback onSave;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final request = state.request;
    final radius = state.result?.radiusKm;
    final canWiden = radius != null && !state.radiusAtMax;

    return SingleChildScrollView(
      key: const ValueKey('search-empty'),
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(
            Icons.search_off_outlined,
            size: 48,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            request.text.isEmpty
                ? l10n.searchEmptyTitleNoQuery
                : l10n.searchEmptyTitle(request.text),
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            l10n.searchEmptyBody,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.md),
          for (final filter in request.activeFilters)
            _Suggestion(
              key: ValueKey('search-empty-remove-${_keyOf(filter)}'),
              icon: Icons.filter_alt_off_outlined,
              label: l10n.searchEmptyRemoveFilter(
                labels.filter(filter, request),
              ),
              onTap: () => onRemoveFilter(filter),
            ),
          if (canWiden)
            _Suggestion(
              key: const ValueKey('search-empty-widen'),
              icon: Icons.zoom_out_map,
              label: l10n.searchEmptyWiden(labels.km(radius * 2)),
              onTap: onWiden,
            ),
          _Suggestion(
            key: const ValueKey('search-empty-save'),
            icon: Icons.notifications_active_outlined,
            label: l10n.searchEmptySave,
            onTap: onSave,
            primary: true,
          ),
        ],
      ),
    );
  }

  static String _keyOf(ActiveFilter filter) => switch (filter) {
    CategoryFilter() => 'category',
    PriceFilter() => 'price',
    FieldFilter(:final field) => 'field-$field',
  };
}

class _Suggestion extends StatelessWidget {
  const _Suggestion({
    required this.icon,
    required this.label,
    required this.onTap,
    super.key,
    this.primary = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final style = primary
        ? FilledButton.styleFrom(alignment: AlignmentDirectional.centerStart)
        : OutlinedButton.styleFrom(alignment: AlignmentDirectional.centerStart);
    final child = Row(
      children: [
        Icon(icon, size: 20),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text(label)),
      ],
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: primary
          ? FilledButton(onPressed: onTap, style: style, child: child)
          : OutlinedButton(onPressed: onTap, style: style, child: child),
    );
  }
}
