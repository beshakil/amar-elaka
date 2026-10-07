import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/saved_controller.dart';
import '../data/saved_api.dart';

const _thumbSize = 56.0;

/// "সেভ করা" (ADR 037): what the user saved, newest first, across areas.
/// An item that sold, expired or closed stays, marked; a post opens its
/// detail. The filter chips narrow to listings, places or shops.
class SavedScreen extends ConsumerStatefulWidget {
  const SavedScreen({super.key});

  @override
  ConsumerState<SavedScreen> createState() => _SavedScreenState();
}

class _SavedScreenState extends ConsumerState<SavedScreen> {
  String? _type;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final saved = ref.watch(savedControllerProvider(_type));
    final controller = ref.read(savedControllerProvider(_type).notifier);
    final filters = <(String?, String)>[
      (null, l10n.savedFilterAll),
      ('post', l10n.savedFilterPosts),
      ('place', l10n.savedFilterPlaces),
      ('store', l10n.savedFilterStores),
    ];

    return Scaffold(
      appBar: AppBar(title: Text(l10n.savedTitle)),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            child: Row(
              children: [
                for (final (type, label) in filters)
                  Padding(
                    padding: const EdgeInsets.only(right: AppSpacing.xs),
                    child: ChoiceChip(
                      key: ValueKey('saved-filter-${type ?? 'all'}'),
                      label: Text(label),
                      selected: _type == type,
                      onSelected: (_) => setState(() => _type = type),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: switch (saved) {
              AsyncData(:final value) when value.items.isEmpty => Center(
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  child: Text(
                    l10n.savedEmpty,
                    key: const ValueKey('saved-empty'),
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
              AsyncData(:final value) => RefreshIndicator(
                onRefresh: () =>
                    ref.refresh(savedControllerProvider(_type).future),
                child: ListView.builder(
                  key: const ValueKey('saved-list'),
                  itemCount: value.items.length + (value.hasMore ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index >= value.items.length) {
                      // Not during build: ask for the next page after this frame.
                      WidgetsBinding.instance.addPostFrameCallback(
                        (_) => unawaited(controller.loadMore()),
                      );
                      return const Padding(
                        padding: EdgeInsets.all(AppSpacing.md),
                        child: Center(child: CircularProgressIndicator()),
                      );
                    }
                    return _SavedTile(
                      item: value.items[index],
                      onUnsave: (item) async {
                        final messenger = ScaffoldMessenger.of(context);
                        final ok = await controller.unsave(item);
                        // The latest answer replaces the last one, not queued behind it.
                        messenger
                          ..hideCurrentSnackBar()
                          ..showSnackBar(
                            SnackBar(
                              content: Text(
                                ok ? l10n.savedRemoved : l10n.savedRemoveFailed,
                              ),
                            ),
                          );
                      },
                    );
                  },
                ),
              ),
              AsyncError() => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(l10n.savedLoadFailed),
                    TextButton(
                      onPressed: () =>
                          ref.invalidate(savedControllerProvider(_type)),
                      child: Text(l10n.placeFeedbackRetry),
                    ),
                  ],
                ),
              ),
              _ => const Center(child: CircularProgressIndicator()),
            },
          ),
        ],
      ),
    );
  }
}

class _SavedTile extends StatelessWidget {
  const _SavedTile({required this.item, required this.onUnsave});

  final SavedItem item;
  final void Function(SavedItem) onUnsave;

  /// A post that can still be looked at (not deleted or removed). Places and
  /// stores have no screen in the app yet: they only show.
  bool get _opens =>
      item.itemType == 'post' &&
      const {'available', 'sold', 'expired'}.contains(item.state);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final name = locale == 'bn'
        ? (item.nameBn ?? item.nameEn)
        : (item.nameEn ?? item.nameBn);
    final area = locale == 'bn'
        ? (item.areaBn ?? item.areaEn)
        : (item.areaEn ?? item.areaBn);
    final stateLabel = switch (item.state) {
      'available' => null,
      'sold' => l10n.savedStateSold,
      'expired' => l10n.savedStateExpired,
      'temporarily_closed' => l10n.savedStateTemporarilyClosed,
      'closed' => l10n.savedStateClosed,
      _ => l10n.savedStateGone,
    };
    final cover = item.coverUrl;
    return ListTile(
      key: ValueKey('saved-${item.itemId}'),
      leading: SizedBox.square(
        dimension: _thumbSize,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppSpacing.xs),
          child: cover == null
              ? ColoredBox(
                  color: theme.colorScheme.surfaceContainerHighest,
                  child: Icon(switch (item.itemType) {
                    'post' => Icons.sell_outlined,
                    'store' => Icons.storefront_outlined,
                    _ => Icons.place_outlined,
                  }),
                )
              : NetworkPhoto(
                  url: cover,
                  thumbhash: item.coverThumbhash,
                  decodeWidth: _thumbSize,
                ),
        ),
      ),
      title: Text(name ?? l10n.savedRemovedItem),
      subtitle: Text(
        [
          if (item.price case final price?) '৳ ${formatMoney(price, locale)}',
          ?area,
          ?stateLabel,
        ].join(' · '),
        style: stateLabel == null
            ? null
            : theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
      ),
      trailing: IconButton(
        key: ValueKey('saved-unsave-${item.itemId}'),
        tooltip: l10n.savedRemove,
        icon: const Icon(Icons.bookmark_remove_outlined),
        onPressed: () => onUnsave(item),
      ),
      onTap: _opens
          ? () => context.push(RoutePaths.postDetailFor(item.itemId))
          : null,
    );
  }
}
