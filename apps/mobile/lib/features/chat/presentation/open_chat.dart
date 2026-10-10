import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../../core/routing/auth_gate.dart';
import '../data/chat_api.dart';

/// "মেসেজ দিন" on a post or a store: sign in if needed, open (or reopen —
/// one conversation per buyer and post or store) and go to it.
Future<void> openChat(
  BuildContext context,
  WidgetRef ref, {
  String? postId,
  String? storeId,
  ChatSource source = ChatSource.postDetail,
}) async {
  if (!requireLogin(context, ref)) return;
  final l10n = AppLocalizations.of(context)!;
  final messenger = ScaffoldMessenger.of(context);
  final router = GoRouter.of(context);
  try {
    final api = ref.read(chatApiProvider);
    final opened = postId != null
        ? await api.openForPost(postId, source)
        : await api.openForStore(storeId!);
    unawaited(router.push(RoutePaths.conversationFor(opened.conversation.id)));
  } on Object {
    messenger.showSnackBar(SnackBar(content: Text(l10n.chatOpenFailed)));
  }
}
