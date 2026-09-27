import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_text_field.dart';
import '../../../../core/design/widgets/empty_state.dart';
import '../../../../core/design/widgets/error_state.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/post_editor.dart';
import '../post_error_messages.dart';
import '../widgets/category_icon.dart';

/// Step 1: a grid of the categories this area takes posts in, with search
/// (either script, either language). Tapping one picks it and moves on.
class CategoryStep extends ConsumerStatefulWidget {
  const CategoryStep({required this.editor, required this.onPicked, super.key});

  final PostEditor editor;
  final VoidCallback onPicked;

  @override
  ConsumerState<CategoryStep> createState() => _CategoryStepState();
}

class _CategoryStepState extends ConsumerState<CategoryStep> {
  String _query = '';

  Future<void> _pick(CatalogCategory category) async {
    final l10n = AppLocalizations.of(context)!;
    final draft = widget.editor.draft!;
    final switching =
        draft.category != null &&
        draft.category!.id != category.id &&
        draft.formState.isNotEmpty;
    if (switching) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
          title: Text(l10n.postCategoryChangeTitle),
          content: Text(l10n.postCategoryChangeMessage),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(false),
              child: Text(l10n.postCancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(true),
              child: Text(l10n.postCategoryChangeConfirm),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    widget.editor.chooseCategory(category);
    widget.onPicked();
  }

  bool _matches(CatalogCategory category) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return category.name.bn.toLowerCase().contains(q) ||
        category.name.en.toLowerCase().contains(q) ||
        category.slug.contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final categories = ref.watch(postableCategoriesProvider);
    final selectedId = widget.editor.draft?.category?.id;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.sm,
            AppSpacing.md,
            AppSpacing.sm,
          ),
          child: AppTextField(
            label: l10n.postCategorySearchHint,
            prefixIcon: Icons.search,
            onChanged: (value) => setState(() => _query = value),
          ),
        ),
        Expanded(
          child: switch (categories) {
            AsyncData(:final value) => _grid(
              [
                for (final c in value)
                  if (_matches(c)) c,
              ],
              selectedId,
              locale,
              l10n,
            ),
            AsyncError(:final error) => ErrorState(
              title: l10n.postCategoryLoadFailed,
              message: error is AppException
                  ? describePostError(error, l10n, locale)
                  : null,
              retryLabel: l10n.genericRetry,
              onRetry: () => ref.invalidate(postableCategoriesProvider),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ],
    );
  }

  Widget _grid(
    List<CatalogCategory> categories,
    String? selectedId,
    String locale,
    AppLocalizations l10n,
  ) {
    if (categories.isEmpty) {
      return EmptyState(title: l10n.postCategoryEmpty, icon: Icons.search_off);
    }
    final theme = Theme.of(context);
    return GridView.builder(
      padding: const EdgeInsets.all(AppSpacing.md),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 120,
        mainAxisSpacing: AppSpacing.sm,
        crossAxisSpacing: AppSpacing.sm,
        childAspectRatio: 0.9,
      ),
      itemCount: categories.length,
      itemBuilder: (context, index) {
        final category = categories[index];
        final selected = category.id == selectedId;
        return Semantics(
          button: true,
          selected: selected,
          child: Material(
            color: selected
                ? theme.colorScheme.primaryContainer
                : theme.colorScheme.surfaceContainerHighest,
            borderRadius: AppRadii.lgRadius,
            child: InkWell(
              key: ValueKey('category-${category.slug}'),
              borderRadius: AppRadii.lgRadius,
              onTap: () => _pick(category),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      categoryIcon(category.iconKey),
                      size: 32,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      category.name.of(locale),
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelMedium,
                    ),
                    if (category.requiresApproval)
                      Icon(
                        Icons.verified_user_outlined,
                        size: 14,
                        semanticLabel: l10n.postCategoryReviewed,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
