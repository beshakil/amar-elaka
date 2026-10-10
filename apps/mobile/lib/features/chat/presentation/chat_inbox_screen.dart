import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/chat_inbox_controller.dart';
import '../data/chat_models.dart';
import 'widgets/conversation_tile.dart';

/// The chat inbox (ADR 060), or the archive with [archived]: newest
/// activity first, live; swipe a conversation to archive it (with undo) —
/// or, in the archive, back to the inbox.
class ChatInboxScreen extends ConsumerWidget {
  const ChatInboxScreen({this.archived = false, super.key});

  final bool archived;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final inbox = ref.watch(chatInboxProvider(archived));
    final controller = ref.read(chatInboxProvider(archived).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(archived ? l10n.chatArchiveTitle : l10n.chatTitle),
        actions: [
          if (!archived)
            IconButton(
              key: const ValueKey('chat-open-archive'),
              tooltip: l10n.chatOpenArchive,
              icon: const Icon(Icons.archive_outlined),
              onPressed: () => unawaited(context.push(RoutePaths.chatArchive)),
            ),
        ],
      ),
      body: switch (inbox) {
        AsyncData(:final value) when value.items.isEmpty => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Text(
              archived ? l10n.chatArchiveEmpty : l10n.chatEmpty,
              key: const ValueKey('chat-empty'),
              textAlign: TextAlign.center,
            ),
          ),
        ),
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(chatInboxProvider(archived).future),
          child: ListView.separated(
            key: const ValueKey('chat-list'),
            itemCount: value.items.length + (value.hasMore ? 1 : 0),
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, index) {
              if (index >= value.items.length) {
                WidgetsBinding.instance.addPostFrameCallback(
                  (_) => unawaited(controller.loadMore()),
                );
                return const Padding(
                  padding: EdgeInsets.all(AppSpacing.md),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              final conversation = value.items[index];
              return Dismissible(
                key: ValueKey('dismiss-${conversation.id}'),
                direction: DismissDirection.endToStart,
                background: _swipeBackground(
                  context,
                  archived ? l10n.chatUnarchive : l10n.chatArchiveAction,
                ),
                onDismissed: (_) =>
                    unawaited(_swiped(context, ref, conversation)),
                child: ConversationTile(
                  conversation: conversation,
                  onTap: () => unawaited(
                    context.push(RoutePaths.conversationFor(conversation.id)),
                  ),
                ),
              );
            },
          ),
        ),
        AsyncError() => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(l10n.chatLoadFailed),
              TextButton(
                onPressed: () => ref.invalidate(chatInboxProvider(archived)),
                child: Text(l10n.chatRetry),
              ),
            ],
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Future<void> _swiped(
    BuildContext context,
    WidgetRef ref,
    Conversation conversation,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final controller = ref.read(chatInboxProvider(archived).notifier);
    try {
      if (archived) {
        await controller.unarchive(conversation);
        return;
      }
      final archivedOne = await controller.archive(conversation.id);
      if (archivedOne == null) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.chatArchived),
          action: SnackBarAction(
            label: l10n.chatUndo,
            onPressed: () => unawaited(controller.unarchive(archivedOne)),
          ),
        ),
      );
    } on Object {
      messenger.showSnackBar(SnackBar(content: Text(l10n.chatLoadFailed)));
    }
  }

  Widget _swipeBackground(BuildContext context, String label) {
    final theme = Theme.of(context);
    return ColoredBox(
      color: theme.colorScheme.secondaryContainer,
      child: Align(
        alignment: AlignmentDirectional.centerEnd,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                archived ? Icons.unarchive_outlined : Icons.archive_outlined,
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(label),
            ],
          ),
        ),
      ),
    );
  }
}
