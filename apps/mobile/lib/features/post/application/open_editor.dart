import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/routing/route_paths.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../data/post_draft_store.dart';
import 'post_editor.dart';

/// Starts a new post: an empty draft with the signed-in profile's name and
/// phone as the contact, then the editor.
Future<void> startNewPost(BuildContext context, WidgetRef ref) async {
  final me = switch (ref.read(authControllerProvider)) {
    AuthSessionAuthenticated(:final me) => me,
    _ => null,
  };
  final draft = await ref
      .read(postDraftStoreProvider)
      .createNew(
        contactName: me?.displayName ?? '',
        contactPhone: me?.phone ?? '',
      );
  if (context.mounted) await context.push(RoutePaths.postEditorFor(draft.id));
}

/// Edits (or fixes and resubmits) a post: a draft of its current values
/// (reused if one is already open), then the editor at the details step.
Future<void> editPost(
  BuildContext context,
  WidgetRef ref,
  PostView post,
) async {
  final locale = Localizations.localeOf(context).languageCode;
  final categories = await ref.read(postableCategoriesProvider.future);
  final category = categories.where((c) => c.id == post.categoryId).firstOrNull;
  final draft = await ref
      .read(postDraftStoreProvider)
      .createEdit(post, category, locale: locale);
  if (context.mounted) await context.push(RoutePaths.postEditorFor(draft.id));
}
