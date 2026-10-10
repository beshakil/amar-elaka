import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../notifications/presentation/push_rationale.dart';
import '../application/chat_outbox.dart';
import '../application/conversation_controller.dart';
import '../data/chat_api.dart';
import '../data/chat_models.dart';
import 'widgets/chat_composer.dart';
import 'widgets/message_bubble.dart';
import 'widgets/post_header_card.dart';
import 'widgets/report_sheet.dart';
import 'widgets/typing_indicator.dart';

/// One conversation (ADR 060): the post card on top, the thread (newest at
/// the bottom; older on scroll up), the other side typing, and the composer
/// — text, quick replies for a store's staff, photo, location. Messages go
/// through the outbox, so they wait offline with a clock tick and go when
/// they can. Block and report are in the menu.
class ConversationScreen extends ConsumerStatefulWidget {
  const ConversationScreen({required this.conversationId, super.key});

  final String conversationId;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription<SendResult>? _sentSubscription;

  /// Close enough to the oldest loaded message to fetch older ones.
  static const _loadOlderThreshold = 200.0;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    // The first chat message the user sends is a moment push obviously helps.
    _sentSubscription = ref.read(chatOutboxProvider).sent.listen((result) {
      if (result.created && mounted) {
        unawaited(offerPushAtMeaningfulMoment(context, ref));
      }
    });
  }

  @override
  void dispose() {
    unawaited(_sentSubscription?.cancel());
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  ConversationController get _controller =>
      ref.read(conversationProvider(widget.conversationId).notifier);

  void _onScroll() {
    // reverse: true — the top of the thread is the scroll's max extent.
    if (_scroll.position.pixels >=
        _scroll.position.maxScrollExtent - _loadOlderThreshold) {
      unawaited(_controller.loadOlder());
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final state = ref.watch(conversationProvider(widget.conversationId));

    return switch (state) {
      AsyncData(:final value) => _thread(context, l10n, locale, value),
      AsyncError() => Scaffold(
        appBar: AppBar(),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(l10n.chatLoadFailed),
              TextButton(
                onPressed: () =>
                    ref.invalidate(conversationProvider(widget.conversationId)),
                child: Text(l10n.chatRetry),
              ),
            ],
          ),
        ),
      ),
      _ => Scaffold(
        appBar: AppBar(),
        body: const Center(child: CircularProgressIndicator()),
      ),
    };
  }

  Widget _thread(
    BuildContext context,
    AppLocalizations l10n,
    String locale,
    ConversationState s,
  ) {
    final c = s.conversation;
    final title = c.counterpartKind == 'store' && c.store != null
        ? c.store!.nameFor(locale)
        : (c.counterpartName ??
              (c.counterpartKind == 'buyer'
                  ? l10n.chatBuyer
                  : l10n.chatSeller));
    // Newest first for a reversed list: pending (newest) then sent, newest to oldest.
    final items = <Widget>[
      if (s.typing) const TypingIndicator(),
      for (final p in s.pending.reversed)
        MessageBubble.pending(
          p,
          key: ValueKey('pending-${p.clientMessageId}'),
          onRetry: () => unawaited(_controller.retry(p)),
          onDiscard: () => unawaited(_controller.discard(p)),
          onEdit: () {
            final draft = p.draft;
            if (draft is TextDraft) _composer.text = draft.body;
            unawaited(_controller.discard(p));
          },
        ),
      for (final m in s.messages.reversed)
        MessageBubble.message(
          m,
          key: ValueKey('message-${m.id}'),
          mine: s.isMine(m),
          state: s.isMine(m) ? deliveryStateOf(m.id, c) : null,
          onOpenListing: (postId) =>
              unawaited(context.push(RoutePaths.postDetailFor(postId))),
          onOpenLocation: _openLocation,
        ),
    ];

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (s.typing)
              Text(
                l10n.chatTyping,
                style: Theme.of(context).textTheme.labelSmall,
              ),
          ],
        ),
        actions: [
          PopupMenuButton<String>(
            key: const ValueKey('chat-menu'),
            onSelected: (action) => unawaited(_menu(context, l10n, action, c)),
            itemBuilder: (_) => [
              PopupMenuItem(
                value: c.blockedByMe ? 'unblock' : 'block',
                child: Text(
                  c.blockedByMe ? l10n.chatMenuUnblock : l10n.chatMenuBlock,
                ),
              ),
              PopupMenuItem(value: 'report', child: Text(l10n.chatMenuReport)),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          PostHeaderCard(
            conversation: c,
            onOpenPost: (postId) =>
                unawaited(context.push(RoutePaths.postDetailFor(postId))),
          ),
          Expanded(
            child: ListView(
              key: const ValueKey('chat-thread'),
              controller: _scroll,
              reverse: true,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
              children: [
                ...items,
                if (s.hasOlder)
                  const Padding(
                    padding: EdgeInsets.all(AppSpacing.md),
                    child: Center(child: CircularProgressIndicator()),
                  ),
              ],
            ),
          ),
          ChatComposer(
            controller: _composer,
            enabled: c.canSend,
            disabledReason: c.isLocked
                ? l10n.chatLockedNotice
                : c.blockedByMe
                ? l10n.chatYouBlocked
                : l10n.chatBlockedNotice,
            quickReplies: s.quickReplies,
            onChanged: _controller.onComposerChanged,
            onSend: () {
              final text = _composer.text;
              _composer.clear();
              unawaited(_controller.sendText(text));
            },
            onAttach: (choice) => unawaited(_attach(context, l10n, choice)),
          ),
        ],
      ),
    );
  }

  Future<void> _attach(
    BuildContext context,
    AppLocalizations l10n,
    AttachChoice choice,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    switch (choice) {
      case AttachChoice.gallery:
      case AttachChoice.camera:
        final picked = await ImagePicker().pickImage(
          source: choice == AttachChoice.camera
              ? ImageSource.camera
              : ImageSource.gallery,
        );
        if (picked != null) await _controller.sendImage(picked.path);
      case AttachChoice.location:
        try {
          var permission = await Geolocator.checkPermission();
          if (permission == LocationPermission.denied) {
            permission = await Geolocator.requestPermission();
          }
          if (permission == LocationPermission.denied ||
              permission == LocationPermission.deniedForever) {
            throw const _NoLocation();
          }
          final position = await Geolocator.getCurrentPosition();
          await _controller.sendLocation(position.latitude, position.longitude);
        } on Object {
          messenger.showSnackBar(
            SnackBar(content: Text(l10n.chatLocationFailed)),
          );
        }
    }
  }

  void _openLocation(double lat, double lng) {
    unawaited(launchUrl(Uri.parse('geo:$lat,$lng?q=$lat,$lng')));
  }

  Future<void> _menu(
    BuildContext context,
    AppLocalizations l10n,
    String action,
    Conversation c,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    switch (action) {
      case 'block':
        final sure = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(l10n.chatBlockConfirmTitle),
            content: Text(l10n.chatBlockConfirmBody),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: Text(l10n.chatCancel),
              ),
              FilledButton(
                key: const ValueKey('chat-block-confirm'),
                onPressed: () => Navigator.pop(context, true),
                child: Text(l10n.chatBlockConfirm),
              ),
            ],
          ),
        );
        if (sure == true) await _controller.setBlocked(blocked: true);
      case 'unblock':
        await _controller.setBlocked(blocked: false);
      case 'report':
        final report = await showChatReportSheet(context);
        if (report == null) return;
        try {
          await _controller.report(report.reasonCode, report.text);
          messenger.showSnackBar(SnackBar(content: Text(l10n.chatReportSent)));
        } on Object {
          messenger.showSnackBar(
            SnackBar(content: Text(l10n.chatGenericError)),
          );
        }
    }
  }
}

class _NoLocation implements Exception {
  const _NoLocation();
}
