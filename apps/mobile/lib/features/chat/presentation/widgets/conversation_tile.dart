import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../data/chat_models.dart';
import 'message_bubble.dart';

/// The inbox's line for a conversation: the post's photo (or the store's
/// initial), who, the last message, when, and the unread badge.
class ConversationTile extends StatelessWidget {
  const ConversationTile({required this.conversation, required this.onTap, super.key});

  final Conversation conversation;
  final VoidCallback onTap;

  static const _thumb = 52.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final c = conversation;
    final name = c.counterpartKind == 'store' && c.store != null
        ? c.store!.nameFor(locale)
        : (c.counterpartName ?? (c.counterpartKind == 'buyer' ? l10n.chatBuyer : l10n.chatSeller));
    final unread = c.unreadCount > 0;
    final preview = _preview(c, l10n);
    final cover = c.post?.cover;

    return ListTile(
      key: ValueKey('conversation-${c.id}'),
      onTap: onTap,
      leading: ClipRRect(
        borderRadius: AppRadii.mdRadius,
        child: SizedBox.square(
          dimension: _thumb,
          child: cover != null
              ? NetworkPhoto(url: cover.url, thumbhash: cover.thumbhash, fit: BoxFit.cover)
              : ColoredBox(
                  color: theme.colorScheme.secondaryContainer,
                  child: Center(
                    child: Text(
                      name.isEmpty ? '?' : name.characters.first,
                      style: theme.textTheme.titleLarge?.copyWith(color: theme.colorScheme.onSecondaryContainer),
                    ),
                  ),
                ),
        ),
      ),
      title: Text(
        name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: unread ? const TextStyle(fontWeight: FontWeight.w700) : null,
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (c.post != null)
            Text(c.post!.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelMedium),
          Text(
            preview,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: unread ? TextStyle(fontWeight: FontWeight.w600, color: theme.colorScheme.onSurface) : null,
          ),
        ],
      ),
      isThreeLine: c.post != null,
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(chatTime(c.activityAt, locale), style: theme.textTheme.labelSmall),
          const SizedBox(height: AppSpacing.xs),
          if (unread)
            Badge(
              key: ValueKey('conversation-unread-${c.id}'),
              label: Text(localizeDigits('${c.unreadCount}', locale)),
            ),
        ],
      ),
    );
  }

  static String _preview(Conversation c, AppLocalizations l10n) {
    final m = c.lastMessage;
    if (m == null) return l10n.chatNoMessagesYet;
    final text = switch (m.kind) {
      MessageKind.text => m.body ?? '',
      MessageKind.image => '📷 ${l10n.chatPhoto}',
      MessageKind.location => '📍 ${l10n.chatLocation}',
      MessageKind.listingCard => l10n.chatListing,
      MessageKind.system => l10n.chatSystemLocked,
    };
    return m.senderMemberId == c.myMemberId ? l10n.chatYou(text) : text;
  }
}
