import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart' show ContactReveal;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/base_map.dart';
import '../../../core/map/directions.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../chat/data/chat_api.dart';
import '../../chat/presentation/open_chat.dart';
import '../../post_detail/application/contact_actions.dart';
import '../../post_detail/presentation/detail_messages.dart';
import '../../post_detail/presentation/widgets/detail_sheets.dart';
import '../application/store_page_controller.dart';
import '../data/store_api.dart';
import '../data/store_models.dart';
import 'widgets/catalog_tile.dart';

/// A store's own screen (ADR 054/057): banner and logo, whether it is open
/// now, follow, call and WhatsApp (each a recorded lead, never a number on
/// screen first), its catalog by category, where it is, and share.
class StoreScreen extends ConsumerWidget {
  const StoreScreen({required this.slug, super.key});

  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final async = ref.watch(storePageProvider(slug));
    return Scaffold(
      appBar: AppBar(
        title: Text(
          async.value?.page.name.of(locale, fallback: l10n.storeTitle) ??
              l10n.storeTitle,
        ),
      ),
      body: switch (async) {
        AsyncData(:final value) => _StoreBody(slug: slug, state: value),
        AsyncError(:final error) => ErrorState(
          key: const ValueKey('store-error'),
          title: error is ApiException && error.statusCode == 404
              ? l10n.storeNotFound
              : l10n.storeLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(storePageProvider(slug)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _StoreBody extends ConsumerStatefulWidget {
  const _StoreBody({required this.slug, required this.state});

  final String slug;
  final StorePageState state;

  @override
  ConsumerState<_StoreBody> createState() => _StoreBodyState();
}

class _StoreBodyState extends ConsumerState<_StoreBody> {
  String? _busy;

  AppLocalizations get _l10n => AppLocalizations.of(context)!;
  String get _locale => Localizations.localeOf(context).languageCode;
  StorePageData get _page => widget.state.page;

  void _say(String message) => ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));

  /// "+8801712345678" -> "01712345678": what people dial and copy here.
  String _localPhone(String e164) => e164.replaceFirst('+88', '');

  Future<ContactReveal> _reveal(String channel) =>
      ref.read(storeApiProvider).contact(_page.id, channel);

  Future<void> _contact(
    String channel,
    Future<ContactOutcome> Function() reveal,
  ) async {
    setState(() => _busy = channel);
    final outcome = await reveal();
    if (!mounted) return;
    setState(() => _busy = null);
    switch (outcome) {
      case ContactOpened():
        return;
      case ContactNotOpened(:final phone):
        _say(_l10n.detailDialerFailed(_localPhone(phone)));
      case ContactFailed(:final error):
        if (error is ApiException && error.code == 'CONTACT_LOGIN_REQUIRED') {
          if (!requireLogin(context, ref)) return;
        }
        _say(detailErrorMessage(error, _l10n, _locale));
      case WhatsAppMissing(:final reveal):
        await _whatsappMissing(reveal);
    }
  }

  Future<void> _whatsappMissing(ContactReveal reveal) async {
    final choice = await WhatsAppMissingSheet.show(
      context,
      reveal: reveal,
      smsAllowed: _page.contactChannels.contains('sms'),
    );
    if (!mounted || choice == null) return;
    final actions = ref.read(contactActionsProvider);
    switch (choice) {
      case WhatsAppAlternative.web:
        if (!await actions.openWhatsappWeb(reveal) && mounted) {
          _say(_l10n.detailDialerFailed(_localPhone(reveal.phone)));
        }
      case WhatsAppAlternative.sms:
        await _contact('sms', () => actions.smsWith(() => _reveal('sms')));
      case WhatsAppAlternative.copy:
        await Clipboard.setData(ClipboardData(text: _localPhone(reveal.phone)));
        if (mounted) _say(_l10n.detailNumberCopied(_localPhone(reveal.phone)));
    }
  }

  Future<void> _toggleFollow() async {
    if (!requireLogin(context, ref)) return;
    try {
      await ref.read(storePageProvider(widget.slug).notifier).toggleFollow();
    } on AppException {
      if (mounted) _say(_l10n.storeFollowFailed);
    }
  }

  Future<void> _directions(({double lat, double lng}) pin) async {
    final opened = await Directions.open(
      ref.read(externalAppsProvider),
      pin.lat,
      pin.lng,
    );
    if (!opened && mounted) _say(_l10n.mapDirectionsFailed);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = _l10n;
    final locale = _locale;
    final theme = Theme.of(context);
    final page = _page;
    final actions = ref.read(contactActionsProvider);
    final controller = ref.read(storePageProvider(widget.slug).notifier);
    String n(int value) => localizeDigits(groupSouthAsian('$value'), locale);

    return CustomScrollView(
      key: const ValueKey('store-page'),
      slivers: [
        SliverToBoxAdapter(child: _Banner(page: page)),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.sm,
            AppSpacing.md,
            0,
          ),
          sliver: SliverList.list(
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      page.name.of(locale),
                      key: const ValueKey('store-name'),
                      style: theme.textTheme.headlineSmall,
                    ),
                  ),
                  if (page.isVerified)
                    Icon(
                      Icons.verified,
                      color: theme.colorScheme.primary,
                      semanticLabel: l10n.storeVerified,
                    ),
                ],
              ),
              const SizedBox(height: AppSpacing.xs),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.xs,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  _OpenPill(hours: page.hours),
                  Text(
                    '${l10n.storeFollowers(n(page.followerCount))} · '
                    '${l10n.storeProductCount(n(page.livePosts))}',
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
              if (page.description case final text? when text.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Text(text, style: theme.textTheme.bodyMedium),
                ),
              const SizedBox(height: AppSpacing.md),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.xs,
                children: [
                  page.isFollowing
                      ? OutlinedButton.icon(
                          key: const ValueKey('store-follow'),
                          icon: const Icon(Icons.check),
                          label: Text(l10n.storeFollowing),
                          onPressed: () => unawaited(_toggleFollow()),
                        )
                      : FilledButton.tonalIcon(
                          key: const ValueKey('store-follow'),
                          icon: const Icon(Icons.add),
                          label: Text(l10n.storeFollow),
                          onPressed: () => unawaited(_toggleFollow()),
                        ),
                  FilledButton.icon(
                    key: const ValueKey('store-chat'),
                    icon: const Icon(Icons.chat_bubble_outline),
                    label: Text(l10n.chatMessageButton),
                    onPressed: () => unawaited(
                      openChat(
                        context,
                        ref,
                        storeId: page.id,
                        source: ChatSource.storePage,
                      ),
                    ),
                  ),
                  if (page.contactChannels.contains('call'))
                    FilledButton.icon(
                      key: const ValueKey('store-call'),
                      icon: _busy == 'call'
                          ? const _Spinner()
                          : const Icon(Icons.call),
                      label: Text(l10n.storeCall),
                      onPressed: _busy != null
                          ? null
                          : () => unawaited(
                              _contact(
                                'call',
                                () => actions.callWith(() => _reveal('call')),
                              ),
                            ),
                    ),
                  if (page.contactChannels.contains('whatsapp'))
                    FilledButton.icon(
                      key: const ValueKey('store-whatsapp'),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF1FA855),
                        foregroundColor: Colors.white,
                      ),
                      icon: _busy == 'whatsapp'
                          ? const _Spinner()
                          : const Icon(Icons.chat_outlined),
                      label: Text(l10n.storeWhatsapp),
                      onPressed: _busy != null
                          ? null
                          : () => unawaited(
                              _contact(
                                'whatsapp',
                                () => actions.whatsappWith(
                                  () => _reveal('whatsapp'),
                                ),
                              ),
                            ),
                    ),
                  IconButton.outlined(
                    key: const ValueKey('store-share'),
                    tooltip: l10n.storeShare,
                    icon: const Icon(Icons.share_outlined),
                    onPressed: () => unawaited(
                      ref
                          .read(externalAppsProvider)
                          .share(
                            l10n.storeShareText(page.name.of(locale), page.url),
                          ),
                    ),
                  ),
                ],
              ),
              if (page.pin case final pin?) ...[
                const SizedBox(height: AppSpacing.md),
                _MapPin(
                  pin: pin,
                  address: [
                    ?page.addressText,
                    ?page.area?.of(locale),
                  ].where((s) => s.isNotEmpty).join(', '),
                  onDirections: () => unawaited(_directions(pin)),
                ),
              ],
              const SizedBox(height: AppSpacing.lg),
              Text(l10n.storeCatalogTitle, style: theme.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.xs),
              if (page.categories.length > 1)
                SingleChildScrollView(
                  key: const ValueKey('store-categories'),
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final (slug, label) in [
                        (null, l10n.storeAllProducts),
                        for (final c in page.categories)
                          (c.slug, '${c.name.of(locale)} (${n(c.count)})'),
                      ])
                        Padding(
                          padding: const EdgeInsets.only(right: AppSpacing.xs),
                          child: ChoiceChip(
                            key: ValueKey('store-category-${slug ?? 'all'}'),
                            label: Text(label),
                            selected: widget.state.category == slug,
                            onSelected: (_) =>
                                unawaited(controller.selectCategory(slug)),
                          ),
                        ),
                    ],
                  ),
                ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ),
        ),
        if (widget.state.switching)
          const SliverToBoxAdapter(child: LinearProgressIndicator())
        else if (page.posts.isEmpty)
          SliverPadding(
            padding: const EdgeInsets.all(AppSpacing.md),
            sliver: SliverToBoxAdapter(
              child: Text(
                l10n.storeCatalogEmpty,
                key: const ValueKey('store-catalog-empty'),
              ),
            ),
          )
        else
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            sliver: SliverGrid.builder(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                maxCrossAxisExtent: 220,
                mainAxisSpacing: AppSpacing.sm,
                crossAxisSpacing: AppSpacing.sm,
                childAspectRatio: 0.72,
              ),
              itemCount: page.posts.length,
              itemBuilder: (context, i) {
                final card = page.posts[i];
                return CatalogTile(
                  card: card,
                  onTap: () => context.push(RoutePaths.postDetailFor(card.id)),
                );
              },
            ),
          ),
        if (page.nextCursor != null)
          SliverPadding(
            padding: const EdgeInsets.all(AppSpacing.md),
            sliver: SliverToBoxAdapter(
              child: Center(
                child: widget.state.loadingMore
                    ? const CircularProgressIndicator()
                    : OutlinedButton(
                        key: const ValueKey('store-load-more'),
                        onPressed: () => unawaited(controller.loadMore()),
                        child: Text(l10n.storeLoadMore),
                      ),
              ),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: AppSpacing.xl)),
      ],
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const SizedBox.square(
    dimension: 18,
    child: CircularProgressIndicator(strokeWidth: 2),
  );
}

/// The banner photo with the logo over its lower edge.
class _Banner extends StatelessWidget {
  const _Banner({required this.page});

  final StorePageData page;

  static const _bannerHeight = 150.0;
  static const _logoSize = 72.0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: _bannerHeight + _logoSize / 2,
      child: Stack(
        children: [
          Positioned.fill(
            bottom: _logoSize / 2,
            child: page.cover == null
                ? ColoredBox(color: theme.colorScheme.primaryContainer)
                : NetworkPhoto(
                    key: const ValueKey('store-banner'),
                    url: page.cover!.url,
                    thumbhash: page.cover!.thumbhash,
                  ),
          ),
          Positioned(
            left: AppSpacing.md,
            bottom: 0,
            child: Container(
              width: _logoSize,
              height: _logoSize,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: theme.colorScheme.surface,
                border: Border.all(color: theme.colorScheme.surface, width: 3),
              ),
              clipBehavior: Clip.antiAlias,
              child: page.logo == null
                  ? Icon(
                      Icons.storefront,
                      size: 36,
                      color: theme.colorScheme.primary,
                    )
                  : NetworkPhoto(
                      key: const ValueKey('store-logo'),
                      url: page.logo!.url,
                      thumbhash: page.logo!.thumbhash,
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "এখন খোলা" and its kin, from the API's open state (one rule, ADR 052).
class _OpenPill extends StatelessWidget {
  const _OpenPill({required this.hours});

  final StoreHours hours;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final (label, color) = hours.closedUntil != null
        ? (l10n.storeClosedToday, theme.colorScheme.error)
        : switch (hours.openState) {
            'open' => (l10n.placeOpenStateOpen, Colors.green.shade700),
            'closes_soon' => (
              l10n.placeOpenStateClosesSoon,
              Colors.orange.shade800,
            ),
            'opens_soon' => (
              l10n.placeOpenStateOpensSoon,
              Colors.orange.shade800,
            ),
            'closed' => (l10n.placeOpenStateClosed, theme.colorScheme.error),
            _ => (
              l10n.placeOpenStateUnknown,
              theme.colorScheme.onSurfaceVariant,
            ),
          };
    return Chip(
      key: const ValueKey('store-open-state'),
      visualDensity: VisualDensity.compact,
      avatar: Icon(Icons.schedule, size: 16, color: color),
      label: Text(label, style: TextStyle(color: color)),
    );
  }
}

/// Where the store is: our own base map with its pin (no gestures — a
/// glance, not a map screen), the address, and directions.
class _MapPin extends StatelessWidget {
  const _MapPin({
    required this.pin,
    required this.address,
    required this.onDirections,
  });

  final ({double lat, double lng}) pin;
  final String address;
  final VoidCallback onDirections;

  static const _height = 140.0;
  static const _zoom = 15.5;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Card(
      key: const ValueKey('store-map-pin'),
      clipBehavior: Clip.antiAlias,
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: _height,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Positioned.fill(
                  child: IgnorePointer(
                    child: BaseMap(
                      initialCenter: LatLng(pin.lat, pin.lng),
                      initialZoom: _zoom,
                    ),
                  ),
                ),
                Padding(
                  // The pin's tip on the point.
                  padding: const EdgeInsets.only(bottom: 36),
                  child: Icon(
                    Icons.location_on,
                    size: 40,
                    color: theme.colorScheme.error,
                  ),
                ),
              ],
            ),
          ),
          ListTile(
            leading: const Icon(Icons.place_outlined),
            title: Text(address.isEmpty ? l10n.storeLocationTitle : address),
            trailing: TextButton(
              key: const ValueKey('store-directions'),
              onPressed: onDirections,
              child: Text(l10n.mapPreviewDirections),
            ),
          ),
        ],
      ),
    );
  }
}
