import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/empty_state.dart';
import '../../../../core/design/widgets/error_state.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../core/dynamic_form/field_schema.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/my_posts.dart';
import '../../application/open_editor.dart';
import '../../application/post_editor.dart';
import '../../data/posts_api.dart';
import '../post_error_messages.dart';
import '../widgets/post_card.dart';
import 'mark_sold_sheet.dart';

/// "My posts": a tab per status (plus hidden), each with its count, and the
/// actions that status allows. Rejected/removed posts say why, with the
/// moderator's note, and offer "edit and resubmit".
class MyPostsScreen extends ConsumerWidget {
  const MyPostsScreen({super.key});

  String _label(MyPostsTab tab, AppLocalizations l10n) => switch (tab) {
    MyPostsTab.live => l10n.myPostsTabLive,
    MyPostsTab.pending => l10n.myPostsTabPending,
    MyPostsTab.sold => l10n.myPostsTabSold,
    MyPostsTab.expired => l10n.myPostsTabExpired,
    MyPostsTab.rejected => l10n.myPostsTabRejected,
    MyPostsTab.hidden => l10n.myPostsTabHidden,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final counts = ref.watch(myPostCountsProvider).value;
    return DefaultTabController(
      length: MyPostsTab.values.length,
      child: Scaffold(
        appBar: AppBar(
          title: Text(l10n.myPostsTitle),
          bottom: TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [
              for (final tab in MyPostsTab.values)
                Tab(
                  key: ValueKey('tab-${tab.name}'),
                  text: counts == null
                      ? _label(tab, l10n)
                      : l10n.myPostsTabWithCount(
                          _label(tab, l10n),
                          localizeDigits('${tab.countIn(counts)}', locale),
                        ),
                ),
            ],
          ),
        ),
        body: TabBarView(
          children: [for (final tab in MyPostsTab.values) _TabList(tab: tab)],
        ),
      ),
    );
  }
}

class _TabList extends ConsumerWidget {
  const _TabList({required this.tab});

  final MyPostsTab tab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final list = ref.watch(myPostsListProvider(tab));
    final categories =
        ref.watch(postableCategoriesProvider).value ??
        const <CatalogCategory>[];
    final schemas = {
      for (final c in categories)
        if (c.fieldSchema != null)
          c.id: CategoryFieldSchema.fromJson(c.fieldSchema!),
    };

    return ListenableBuilder(
      listenable: list,
      builder: (context, _) {
        if (list.items.isEmpty && list.loading) {
          return const Center(child: CircularProgressIndicator());
        }
        if (list.items.isEmpty && list.error != null) {
          return ErrorState(
            title: l10n.myPostsLoadFailed,
            message: describePostError(list.error!, l10n, locale),
            retryLabel: l10n.genericRetry,
            onRetry: list.refresh,
          );
        }
        return RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(myPostCountsProvider);
            await list.refresh();
          },
          child: list.items.isEmpty
              ? ListView(
                  children: [
                    const SizedBox(height: AppSpacing.xl),
                    EmptyState(
                      title: l10n.myPostsEmpty,
                      icon: Icons.inbox_outlined,
                    ),
                  ],
                )
              : NotificationListener<ScrollEndNotification>(
                  onNotification: (notification) {
                    if (notification.metrics.extentAfter < 400) list.loadMore();
                    return false;
                  },
                  child: ListView.separated(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    itemCount: list.items.length + (list.hasMore ? 1 : 0),
                    separatorBuilder: (_, _) =>
                        const SizedBox(height: AppSpacing.sm),
                    itemBuilder: (context, index) {
                      if (index == list.items.length) {
                        return const Center(
                          child: Padding(
                            padding: EdgeInsets.all(AppSpacing.md),
                            child: CircularProgressIndicator(),
                          ),
                        );
                      }
                      final post = list.items[index];
                      return _MyPostTile(
                        post: post,
                        schema: schemas[post.categoryId],
                      );
                    },
                  ),
                ),
        );
      },
    );
  }
}

class _MyPostTile extends ConsumerWidget {
  const _MyPostTile({required this.post, required this.schema});

  final PostView post;
  final CategoryFieldSchema? schema;

  /// Runs an action, then refreshes every tab and the counts (a post may
  /// have moved tab), and says what happened — or exactly why not.
  Future<void> _run(
    BuildContext context,
    WidgetRef ref,
    Future<Object?> Function(PostsApi api) action,
    String done,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action(ref.read(postsApiProvider));
      messenger.showSnackBar(SnackBar(content: Text(done)));
      ref.invalidate(myPostsListProvider);
      ref.invalidate(myPostCountsProvider);
    } on AppException catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(describePostError(error, l10n, locale))),
      );
    }
  }

  Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        content: Text(l10n.myPostsDeleteConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(l10n.postCancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(true),
            child: Text(l10n.myPostsDelete),
          ),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      await _run(
        context,
        ref,
        (api) => api.delete(post.id),
        l10n.myPostsDeletedDone,
      );
    }
  }

  Future<void> _markSold(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context)!;
    final choice = await showMarkSoldSheet(context);
    if (choice != null && context.mounted) {
      await _run(
        context,
        ref,
        (api) => api.markSold(post.id, soldPrice: choice.soldPrice),
        l10n.myPostsMarkedSold,
      );
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final hidden = post.hiddenByOwner ?? false;
    final data = PostDisplayData.fromPost(post, schema, l10n, locale);

    Widget action(
      String key,
      String label,
      IconData icon,
      VoidCallback onPressed,
    ) => TextButton.icon(
      key: ValueKey('$key-${post.id}'),
      onPressed: onPressed,
      icon: Icon(icon, size: 18),
      label: Text(label),
    );

    final status = hidden ? 'hidden' : post.status;
    final actions = <Widget>[
      if (!hidden &&
          (status == 'live' || status == 'pending' || status == 'expired'))
        action(
          'edit',
          l10n.myPostsEdit,
          Icons.edit_outlined,
          () => editPost(context, ref, post),
        ),
      if (!hidden && status == 'live') ...[
        action(
          'sold',
          l10n.myPostsMarkSold,
          Icons.sell_outlined,
          () => _markSold(context, ref),
        ),
        action(
          'renew',
          l10n.myPostsRenew,
          Icons.update,
          () => _run(
            context,
            ref,
            (api) => api.repost(post.id),
            l10n.myPostsRenewed,
          ),
        ),
      ],
      if (!hidden && status == 'expired')
        action(
          'repost',
          l10n.myPostsRepost,
          Icons.replay,
          () => _run(
            context,
            ref,
            (api) => api.repost(post.id),
            l10n.myPostsReposted,
          ),
        ),
      if (!hidden && (status == 'rejected' || status == 'removed'))
        action(
          'resubmit',
          l10n.myPostsEditResubmit,
          Icons.edit_note,
          () => editPost(context, ref, post),
        ),
      if (!hidden && (status == 'live' || status == 'sold'))
        action(
          'hide',
          l10n.myPostsHide,
          Icons.visibility_off_outlined,
          () => _run(
            context,
            ref,
            (api) => api.setHidden(post.id, hidden: true),
            l10n.myPostsHiddenDone,
          ),
        ),
      if (hidden)
        action(
          'unhide',
          l10n.myPostsUnhide,
          Icons.visibility_outlined,
          () => _run(
            context,
            ref,
            (api) => api.setHidden(post.id, hidden: false),
            l10n.myPostsUnhiddenDone,
          ),
        ),
      if (post.status != 'sold')
        action(
          'delete',
          l10n.myPostsDelete,
          Icons.delete_outline,
          () => _delete(context, ref),
        ),
    ];

    final notes = <String>[
      if (post.status == 'rejected' || post.status == 'removed') ...[
        l10n.myPostsReason(
          describeModerationReason(post.moderationReason, l10n),
        ),
        if (post.moderationNote case final note? when note.trim().isNotEmpty)
          l10n.myPostsModeratorNote(note.trim()),
      ],
      if (post.status == 'live' && post.expiresAt != null)
        l10n.myPostsExpiresOn(
          localizeDigits(
            DateFormat.MMMMd(locale).format(post.expiresAt!.toLocal()),
            locale,
          ),
        ),
      if (post.isSold && post.soldPrice != null)
        l10n.myPostsSoldFor('৳ ${formatMoney(post.soldPrice!, locale)}'),
    ];

    return PostCard(
      data: data,
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final note in notes)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                note,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: post.status == 'rejected' || post.status == 'removed'
                      ? theme.colorScheme.error
                      : theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          Wrap(spacing: AppSpacing.xs, children: actions),
        ],
      ),
    );
  }
}
