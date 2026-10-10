import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../data/chat_models.dart';

/// The post a conversation is about, pinned above the thread (ADR 060):
/// photo, title, price, a tap to open it. After the post's removal it says
/// so, with nothing of it (Q46).
class PostHeaderCard extends StatelessWidget {
  const PostHeaderCard({
    required this.conversation,
    this.onOpenPost,
    super.key,
  });

  final Conversation conversation;
  final ValueChanged<String>? onOpenPost;

  static const _thumb = 48.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final post = conversation.post;
    if (post == null) {
      if (!conversation.postRemoved) return const SizedBox.shrink();
      return _frame(
        theme,
        child: Text(
          l10n.chatPostRemoved,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontStyle: FontStyle.italic,
          ),
        ),
      );
    }
    return _frame(
      theme,
      onTap: () => onOpenPost?.call(post.id),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: AppRadii.mdRadius,
            child: SizedBox.square(
              dimension: _thumb,
              child: NetworkPhoto(
                url: post.cover?.url,
                thumbhash: post.cover?.thumbhash,
                fit: BoxFit.cover,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  post.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall,
                ),
                if (post.price != null)
                  Text(
                    '৳${formatMoney(post.price!, locale)}',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
              ],
            ),
          ),
          Text(
            l10n.chatViewPost,
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.primary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _frame(
    ThemeData theme, {
    required Widget child,
    VoidCallback? onTap,
  }) => Material(
    key: const ValueKey('chat-post-card'),
    color: theme.colorScheme.surfaceContainerLow,
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: child,
      ),
    ),
  );
}
