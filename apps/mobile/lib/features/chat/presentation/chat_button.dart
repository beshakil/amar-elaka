import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/chat_inbox_controller.dart';

/// The app bar's chat icon with the unread messages; signed-in users only.
class ChatInboxButton extends ConsumerWidget {
  const ChatInboxButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final unread = ref.watch(chatUnreadProvider);
    return IconButton(
      key: const ValueKey('chat-inbox-button'),
      tooltip: l10n.chatTitle,
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(localizeDigits('$unread', locale)),
        child: const Icon(Icons.chat_bubble_outline),
      ),
      onPressed: () => unawaited(context.push(RoutePaths.chat)),
    );
  }
}
