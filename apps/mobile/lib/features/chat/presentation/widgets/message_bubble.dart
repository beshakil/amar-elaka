import 'dart:io';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/chat_outbox.dart';
import '../../data/chat_models.dart';

/// "১৪:০৫" / "14:05": a message's time in the reader's digits.
String chatTime(DateTime at, String locale) =>
    localizeDigits(DateFormat.Hm(locale).format(at.toLocal()), locale);

/// One message in a thread (ADR 060): text, photo, location, a shared post
/// card, or a system line. Mine on the right in the primary container
/// colour with ticks; theirs on the left. Long Bengali text wraps at the
/// bubble's width, never clipped; mixed Bengali/English runs in one
/// paragraph (the app's Bengali-first font stack).
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    required this.mine,
    required this.kind,
    required this.at,
    this.body,
    this.image,
    this.localImagePath,
    this.lat,
    this.lng,
    this.listing,
    this.systemEvent,
    this.state,
    this.errorCode,
    this.onRetry,
    this.onDiscard,
    this.onEdit,
    this.onOpenListing,
    this.onOpenLocation,
    super.key,
  });

  /// A message from the server.
  factory MessageBubble.message(
    ChatMessage m, {
    required bool mine,
    DeliveryState? state,
    ValueChanged<String>? onOpenListing,
    void Function(double lat, double lng)? onOpenLocation,
    Key? key,
  }) => MessageBubble(
    key: key,
    mine: mine,
    kind: m.kind,
    at: m.createdAt,
    body: m.body,
    image: m.image,
    lat: m.lat,
    lng: m.lng,
    listing: m.listing,
    systemEvent: m.systemEvent,
    state: mine ? state : null,
    onOpenListing: onOpenListing,
    onOpenLocation: onOpenLocation,
  );

  /// Mine, still in the outbox (pending, or refused with a reason).
  factory MessageBubble.pending(
    PendingMessage p, {
    VoidCallback? onRetry,
    VoidCallback? onDiscard,
    VoidCallback? onEdit,
    Key? key,
  }) {
    final draft = p.draft;
    return MessageBubble(
      key: key,
      mine: true,
      kind: switch (draft) {
        TextDraft() => MessageKind.text,
        ImageDraft() => MessageKind.image,
        LocationDraft() => MessageKind.location,
        ListingDraft() => MessageKind.listingCard,
      },
      at: p.createdAt,
      body: draft is TextDraft ? draft.body : null,
      localImagePath: p.localImagePath,
      lat: draft is LocationDraft ? draft.lat : null,
      lng: draft is LocationDraft ? draft.lng : null,
      state: p.failed ? DeliveryState.failed : DeliveryState.pending,
      errorCode: p.errorCode,
      onRetry: onRetry,
      onDiscard: onDiscard,
      onEdit: draft is TextDraft ? onEdit : null,
    );
  }

  final bool mine;
  final MessageKind kind;
  final DateTime at;
  final String? body;
  final ChatImage? image;
  final String? localImagePath;
  final double? lat;
  final double? lng;
  final ChatListing? listing;
  final String? systemEvent;

  /// Mine only: the ticks.
  final DeliveryState? state;
  final String? errorCode;
  final VoidCallback? onRetry;
  final VoidCallback? onDiscard;
  final VoidCallback? onEdit;
  final ValueChanged<String>? onOpenListing;
  final void Function(double lat, double lng)? onOpenLocation;

  /// A bubble takes at most this share of the thread's width.
  static const _maxWidthFactor = 0.78;
  static const _photoMaxHeight = 260.0;
  static const _listingThumb = 56.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;

    if (kind == MessageKind.system) {
      return Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHigh,
            borderRadius: AppRadii.fullRadius,
          ),
          child: Text(
            systemEvent == 'conversation_locked' ? l10n.chatSystemLocked : l10n.chatGenericError,
            style: theme.textTheme.labelMedium,
          ),
        ),
      );
    }

    final background = mine ? theme.colorScheme.primaryContainer : theme.colorScheme.surfaceContainerHighest;
    final foreground = mine ? theme.colorScheme.onPrimaryContainer : theme.colorScheme.onSurface;
    final failed = state == DeliveryState.failed;

    final bubble = Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * _maxWidthFactor),
      decoration: BoxDecoration(
        color: failed ? theme.colorScheme.errorContainer : background,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(AppRadii.lg),
          topRight: const Radius.circular(AppRadii.lg),
          bottomLeft: Radius.circular(mine ? AppRadii.lg : AppRadii.sm),
          bottomRight: Radius.circular(mine ? AppRadii.sm : AppRadii.lg),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          _content(context, l10n, theme, locale, foreground),
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.sm, 0, AppSpacing.sm, AppSpacing.xs),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  chatTime(at, locale),
                  style: theme.textTheme.labelSmall?.copyWith(color: foreground.withValues(alpha: 0.7)),
                ),
                if (state != null) ...[
                  const SizedBox(width: AppSpacing.xs),
                  DeliveryTicks(state: state!, color: foreground.withValues(alpha: 0.7)),
                ],
              ],
            ),
          ),
        ],
      ),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          bubble,
          if (failed) _FailedNote(errorCode: errorCode, onRetry: onRetry, onDiscard: onDiscard, onEdit: onEdit),
        ],
      ),
    );
  }

  Widget _content(BuildContext context, AppLocalizations l10n, ThemeData theme, String locale, Color foreground) {
    switch (kind) {
      case MessageKind.image:
        final img = image;
        return ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: _photoMaxHeight),
          child: img != null
              ? AspectRatio(
                  aspectRatio: img.card.width / img.card.height,
                  child: NetworkPhoto(url: img.card.url, thumbhash: img.thumbhash, fit: BoxFit.cover, semanticLabel: l10n.chatPhoto),
                )
              : localImagePath != null
              ? Image.file(File(localImagePath!), fit: BoxFit.cover, errorBuilder: (_, _, _) => _pendingPhoto(theme))
              : _pendingPhoto(theme),
        );
      case MessageKind.location:
        return InkWell(
          onTap: lat != null && lng != null ? () => onOpenLocation?.call(lat!, lng!) : null,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.location_on, color: theme.colorScheme.error),
                const SizedBox(width: AppSpacing.sm),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(l10n.chatLocation, style: theme.textTheme.titleSmall?.copyWith(color: foreground)),
                    Text(l10n.chatOpenMap, style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.primary)),
                  ],
                ),
              ],
            ),
          ),
        );
      case MessageKind.listingCard:
        final card = listing;
        if (card == null || card.removed) {
          return Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Text(
              l10n.chatListingRemoved,
              style: theme.textTheme.bodyMedium?.copyWith(color: foreground, fontStyle: FontStyle.italic),
            ),
          );
        }
        return InkWell(
          onTap: () => onOpenListing?.call(card.postId!),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ClipRRect(
                  borderRadius: AppRadii.mdRadius,
                  child: SizedBox.square(
                    dimension: _listingThumb,
                    child: NetworkPhoto(url: card.cover?.url, thumbhash: card.cover?.thumbhash, fit: BoxFit.cover),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(card.title!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall?.copyWith(color: foreground)),
                      if (card.price != null)
                        Text('৳${formatMoney(card.price!, locale)}', style: theme.textTheme.labelLarge?.copyWith(color: foreground)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      case MessageKind.text:
      case MessageKind.system:
        return Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xxs),
          child: SelectableText(
            body ?? '',
            style: theme.textTheme.bodyLarge?.copyWith(color: foreground),
          ),
        );
    }
  }

  Widget _pendingPhoto(ThemeData theme) => SizedBox(
    width: _photoMaxHeight,
    height: _photoMaxHeight * 0.75,
    child: ColoredBox(
      color: theme.colorScheme.surfaceContainer,
      child: const Center(child: Icon(Icons.image_outlined)),
    ),
  );
}

/// The ticks: ⏱ pending, ✓ sent, ✓✓ delivered, ✓✓ in the secondary colour read, ⚠ failed.
class DeliveryTicks extends StatelessWidget {
  const DeliveryTicks({required this.state, required this.color, super.key});

  final DeliveryState state;
  final Color color;
  static const _size = 16.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final (icon, tint, label) = switch (state) {
      DeliveryState.pending => (Icons.schedule, color, l10n.chatStatusPending),
      DeliveryState.sent => (Icons.check, color, l10n.chatStatusSent),
      DeliveryState.delivered => (Icons.done_all, color, l10n.chatStatusDelivered),
      // The brand's second colour: on the green bubble, read has to stand apart from delivered.
      DeliveryState.read => (Icons.done_all, theme.colorScheme.secondary, l10n.chatStatusRead),
      DeliveryState.failed => (Icons.error_outline, theme.colorScheme.error, l10n.chatStatusFailed),
    };
    return Icon(icon, size: _size, color: tint, semanticLabel: label, key: ValueKey('ticks-${state.name}'));
  }
}

class _FailedNote extends StatelessWidget {
  const _FailedNote({this.errorCode, this.onRetry, this.onDiscard, this.onEdit});

  final String? errorCode;
  final VoidCallback? onRetry;
  final VoidCallback? onDiscard;
  final VoidCallback? onEdit;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final reason = switch (errorCode) {
      'CHAT_CONTACT_INFO_BLOCKED' => l10n.chatContactInfoBlocked,
      'CHAT_BLOCKED' => l10n.chatBlockedNotice,
      'CHAT_LOCKED' => l10n.chatLockedNotice,
      'CHAT_IMAGE_INVALID' => l10n.chatImageInvalid,
      'CHAT_MESSAGE_TOO_LONG' => l10n.chatTooLong,
      'CHAT_RATE_LIMITED' => l10n.chatRateLimited,
      _ => l10n.chatGenericError,
    };
    final retryable = errorCode == null || errorCode == 'CHAT_RATE_LIMITED';
    return Container(
      key: const ValueKey('chat-failed-note'),
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * MessageBubble._maxWidthFactor),
      padding: const EdgeInsets.only(top: AppSpacing.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(reason, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error), textAlign: TextAlign.end),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: AppSpacing.xs,
            children: [
              if (onEdit != null && errorCode == 'CHAT_CONTACT_INFO_BLOCKED')
                TextButton(onPressed: onEdit, child: Text(l10n.chatFailedEdit)),
              if (retryable && onRetry != null) TextButton(onPressed: onRetry, child: Text(l10n.chatFailedRetry)),
              if (onDiscard != null) TextButton(onPressed: onDiscard, child: Text(l10n.chatFailedDiscard)),
            ],
          ),
        ],
      ),
    );
  }
}
