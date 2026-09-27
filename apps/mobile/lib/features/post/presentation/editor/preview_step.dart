import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/post_editor.dart';
import '../widgets/post_card.dart';
import '../widgets/post_detail_view.dart';

/// Step 6: the post exactly as others will see it — the same PostCard and
/// PostDetailView the feed and detail page use, fed from the draft.
class PreviewStep extends StatelessWidget {
  const PreviewStep({required this.editor, super.key});

  final PostEditor editor;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final heading = Theme.of(context).textTheme.labelLarge;
    return ListenableBuilder(
      listenable: Listenable.merge([editor, editor.photos]),
      builder: (context, _) {
        final data = PostDisplayData.fromDraft(
          editor.draft!,
          editor.photos.items,
          l10n,
          locale,
        );
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Text(l10n.postPreviewCardTitle, style: heading),
            const SizedBox(height: AppSpacing.sm),
            PostCard(data: data),
            const SizedBox(height: AppSpacing.lg),
            Text(l10n.postPreviewDetailTitle, style: heading),
            const SizedBox(height: AppSpacing.sm),
            PostDetailView(data: data, interactive: false),
          ],
        );
      },
    );
  }
}
