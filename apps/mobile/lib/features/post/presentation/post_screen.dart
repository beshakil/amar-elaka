import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../application/draft_sync.dart';
import '../application/open_editor.dart';
import '../data/post_draft_store.dart';
import '../domain/post_draft.dart';

/// Drafts not yet on the server, newest first (live from Drift).
final unfinishedDraftsProvider = StreamProvider.autoDispose<List<PostDraft>>(
  (ref) => ref.watch(postDraftStoreProvider).watchUnfinished(),
);

/// The Post tab: start a post, resume an unfinished draft (including ones
/// waiting for a connection), or open "my posts". Posting needs an account
/// (docs/decisions/020-mobile-auth-tenant-bootstrap-flows.md).
class PostScreen extends ConsumerWidget {
  const PostScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    if (ref.watch(authControllerProvider) is! AuthSessionAuthenticated) {
      return EmptyState(
        title: l10n.postNewHint,
        icon: Icons.add_box_outlined,
        actionLabel: l10n.postLoginRequiredMessage,
        onAction: () => requireLogin(context, ref),
      );
    }
    // Sends queued drafts whenever the connection comes back.
    ref.watch(draftSyncProvider);
    final drafts =
        ref.watch(unfinishedDraftsProvider).value ?? const <PostDraft>[];
    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l10n.postNewHint, style: theme.textTheme.bodyMedium),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                key: const ValueKey('post-new'),
                label: l10n.postNewAction,
                icon: Icons.add,
                onPressed: () => startNewPost(context, ref),
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                key: const ValueKey('post-mine'),
                label: l10n.postMyPostsAction,
                icon: Icons.list_alt_outlined,
                variant: AppButtonVariant.secondary,
                onPressed: () => context.push(RoutePaths.myPosts),
              ),
            ],
          ),
        ),
        if (drafts.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.lg),
          Text(l10n.postDraftsTitle, style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          for (final draft in drafts) ...[
            _DraftTile(draft: draft),
            const SizedBox(height: AppSpacing.sm),
          ],
        ],
      ],
    );
  }
}

class _DraftTile extends ConsumerWidget {
  const _DraftTile({required this.draft});

  final PostDraft draft;

  Future<void> _discard(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        content: Text(l10n.postDraftDiscardConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(l10n.postCancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(true),
            child: Text(l10n.postDraftDiscard),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(postDraftStoreProvider).delete(draft.id);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final saved = localizeDigits(
      DateFormat.MMMd(locale).add_jm().format(draft.updatedAt),
      locale,
    );
    final title = draft.title.trim().isEmpty
        ? l10n.postDraftUntitled
        : draft.title.trim();
    final subtitle = [
      ?draft.category?.name.of(locale),
      if (draft.isEdit) l10n.postDraftEditOf,
      draft.submitState == DraftSubmitState.queued
          ? l10n.postDraftQueued
          : l10n.postDraftSavedAt(saved),
    ].join(' · ');

    return AppCard(
      onTap: () => context.push(RoutePaths.postEditorFor(draft.id)),
      child: Row(
        children: [
          Icon(
            draft.submitState == DraftSubmitState.queued
                ? Icons.cloud_upload_outlined
                : Icons.edit_note,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: theme.textTheme.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(subtitle, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          IconButton(
            tooltip: l10n.postDraftDiscard,
            icon: const Icon(Icons.delete_outline),
            onPressed: () => _discard(context, ref),
          ),
        ],
      ),
    );
  }
}
