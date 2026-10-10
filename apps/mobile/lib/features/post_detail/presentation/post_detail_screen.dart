import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/loading_shimmer.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../chat/presentation/open_chat.dart';
import '../../feed/presentation/listing_format.dart';
import '../../feed/presentation/widgets/post_listing_card.dart';
import '../application/contact_actions.dart';
import '../application/post_detail_controller.dart';
import '../data/engagement_api.dart';
import 'detail_messages.dart';
import 'widgets/contact_bar.dart';
import 'widgets/detail_fields_table.dart';
import 'widgets/detail_sheets.dart';
import 'widgets/photo_gallery.dart';
import 'widgets/seller_card.dart';

/// A post's page (ADR 038): swipeable photos (pinch zoom full screen), the
/// price and fields, the seller, similar posts, and a sticky bar — Call and
/// WhatsApp go through the contact endpoint (the lead) before anything
/// opens; Save and Share. Report sits in the overflow menu.
class PostDetailScreen extends ConsumerStatefulWidget {
  const PostDetailScreen({required this.postId, super.key});

  final String postId;

  @override
  ConsumerState<PostDetailScreen> createState() => _PostDetailScreenState();
}

class _PostDetailScreenState extends ConsumerState<PostDetailScreen> {
  /// The channel whose reveal is on its way (call | whatsapp | sms).
  String? _busy;

  AppLocalizations get _l10n => AppLocalizations.of(context)!;
  String get _locale => Localizations.localeOf(context).languageCode;

  void _say(String message) => ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));

  bool _mayContact(PostDetail detail) =>
      !detail.contact.loginRequired || requireLogin(context, ref);

  Future<void> _contact(
    String channel,
    Future<ContactOutcome> Function() reveal,
  ) async {
    setState(() => _busy = channel);
    final outcome = await reveal();
    if (!mounted) return;
    setState(() => _busy = null);
    await _handle(outcome);
  }

  Future<void> _handle(ContactOutcome outcome) async {
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
    final detail = ref.read(postDetailProvider(widget.postId)).value;
    final choice = await WhatsAppMissingSheet.show(
      context,
      reveal: reveal,
      smsAllowed: detail?.contact.channels.contains('sms') ?? false,
    );
    if (!mounted || choice == null) return;
    final actions = ref.read(contactActionsProvider);
    switch (choice) {
      case WhatsAppAlternative.web:
        if (!await actions.openWhatsappWeb(reveal) && mounted) {
          _say(_l10n.detailDialerFailed(_localPhone(reveal.phone)));
        }
      case WhatsAppAlternative.sms:
        await _contact('sms', () => actions.sms(widget.postId));
      case WhatsAppAlternative.copy:
        await Clipboard.setData(ClipboardData(text: _localPhone(reveal.phone)));
        if (mounted) _say(_l10n.detailNumberCopied(_localPhone(reveal.phone)));
    }
  }

  /// "+8801712345678" -> "01712345678": what people dial and copy here.
  String _localPhone(String e164) => e164.replaceFirst('+88', '');

  Future<void> _toggleSaved() async {
    if (!requireLogin(context, ref)) return;
    try {
      await ref.read(postDetailProvider(widget.postId).notifier).toggleSaved();
    } on AppException catch (error) {
      if (mounted) _say(detailErrorMessage(error, _l10n, _locale));
    }
  }

  Future<void> _share(PostDetail detail) => ref
      .read(externalAppsProvider)
      .share(_l10n.detailShareText(detail.title, detail.share!.url));

  Future<void> _report() async {
    if (!requireLogin(context, ref)) return;
    final picked = await ReportSheet.show(context);
    if (picked == null || !mounted) return;
    try {
      await ref
          .read(engagementApiProvider)
          .report(widget.postId, picked.reason, picked.text);
      if (mounted) _say(_l10n.detailReportSent);
    } on AppException catch (error) {
      if (mounted) _say(detailErrorMessage(error, _l10n, _locale));
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(postDetailProvider(widget.postId));
    final detail = async.value;
    final actions = ref.read(contactActionsProvider);

    return Scaffold(
      appBar: AppBar(
        actions: [
          if (detail != null && !detail.isMine)
            PopupMenuButton<String>(
              key: const ValueKey('detail-overflow'),
              tooltip: _l10n.detailMore,
              onSelected: (_) => _report(),
              itemBuilder: (context) => [
                PopupMenuItem(
                  key: const ValueKey('detail-report'),
                  value: 'report',
                  child: Text(_l10n.detailReport),
                ),
              ],
            ),
        ],
      ),
      bottomNavigationBar: detail == null
          ? null
          : ContactBar(
              detail: detail,
              busy: _busy,
              onChat: () =>
                  unawaited(openChat(context, ref, postId: widget.postId)),
              onCall: () {
                if (_mayContact(detail)) {
                  _contact('call', () => actions.call(widget.postId));
                }
              },
              onWhatsapp: () {
                if (_mayContact(detail)) {
                  _contact('whatsapp', () => actions.whatsapp(widget.postId));
                }
              },
              onToggleSaved: _toggleSaved,
              onShare: () => _share(detail),
            ),
      body: switch (async) {
        AsyncData(:final value) => _DetailBody(detail: value),
        AsyncError(:final error) =>
          error is ApiException && error.statusCode == 404
              ? EmptyState(
                  title: _l10n.detailNotFoundTitle,
                  message: _l10n.detailNotFoundBody,
                  icon: Icons.visibility_off_outlined,
                )
              : ErrorState(
                  title: _l10n.detailLoadError,
                  message: error is ApiException ? null : _l10n.detailOffline,
                  retryLabel: _l10n.feedRetry,
                  onRetry: () =>
                      ref.invalidate(postDetailProvider(widget.postId)),
                ),
        _ => const _DetailSkeleton(),
      },
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.detail});

  final PostDetail detail;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final meta = [
      ?detail.area?.of(locale),
      ?ListingFormat.distance(detail.distanceMeters, l10n, locale),
      ?detail.category.name.of(locale),
    ].join(' · ');
    final price = ListingFormat.price(
      detail.price,
      detail.priceType,
      l10n,
      locale,
    );

    return ListView(
      key: const ValueKey('detail-body'),
      padding: EdgeInsets.zero,
      children: [
        DetailGallery(media: detail.media, title: detail.title),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (detail.isSold)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                  child: Chip(
                    label: Text(l10n.detailSold),
                    visualDensity: VisualDensity.compact,
                  ),
                ),
              Text(detail.title, style: theme.textTheme.headlineSmall),
              const SizedBox(height: AppSpacing.xs),
              Text(
                detail.priceType == 'negotiable' && detail.price != null
                    ? '$price (${l10n.feedBadgeNegotiable})'
                    : price,
                style: theme.textTheme.titleLarge?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (meta.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  meta,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.md),
              if (detail.fields.any((f) => f.key != 'price')) ...[
                Text(l10n.detailDetails, style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.sm),
                DetailFieldsTable(fields: detail.fields),
                const SizedBox(height: AppSpacing.md),
              ],
              if (detail.description case final description?
                  when description.trim().isNotEmpty) ...[
                Text(
                  l10n.detailDescription,
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.xs),
                // The seller's own words, as written: digits in free text are
                // not ours to rewrite ("Used 6 months" read "Used ৬ months").
                Text(description),
                const SizedBox(height: AppSpacing.md),
              ],
              SellerCardView(seller: detail.seller),
              if (detail.similar.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.lg),
                Text(l10n.detailSimilar, style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.sm),
                for (final card in detail.similar) ...[
                  PostListingCard(
                    card: card,
                    onTap: () =>
                        context.push(RoutePaths.postDetailFor(card.id)),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _DetailSkeleton extends StatelessWidget {
  const _DetailSkeleton();

  @override
  Widget build(BuildContext context) => ListView(
    padding: EdgeInsets.zero,
    children: const [
      AspectRatio(
        aspectRatio: DetailGallery.aspectRatio,
        child: LoadingShimmer(height: double.infinity),
      ),
      Padding(
        padding: EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            LoadingShimmer(height: 28, width: 240),
            SizedBox(height: AppSpacing.sm),
            LoadingShimmer(height: 24, width: 120),
            SizedBox(height: AppSpacing.md),
            LoadingShimmer(height: 120),
          ],
        ),
      ),
    ],
  );
}
