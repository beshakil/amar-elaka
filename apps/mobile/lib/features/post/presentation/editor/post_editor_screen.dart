import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/design/widgets/empty_state.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../core/routing/route_paths.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/post_editor.dart';
import '../../application/post_submitter.dart';
import '../../domain/post_draft.dart';
import '../../domain/post_step.dart';
import '../post_error_messages.dart';
import 'category_step.dart';
import 'contact_step.dart';
import 'details_step.dart';
import 'location_step.dart';
import 'photos_step.dart';
import 'post_result_screen.dart';
import 'preview_step.dart';
import 'step_gate.dart';

/// The create/edit stepper: one concern per screen, "next" checks the
/// current step, and every change is already saved (PostEditor) — closing
/// the screen at any point keeps the draft for later.
class PostEditorScreen extends ConsumerStatefulWidget {
  const PostEditorScreen({required this.draftId, super.key, this.picker});

  final String draftId;

  /// Injectable for tests (the photos step's picker).
  final ImagePicker? picker;

  @override
  ConsumerState<PostEditorScreen> createState() => _PostEditorScreenState();
}

class _PostEditorScreenState extends ConsumerState<PostEditorScreen> {
  final _gate = StepGate();
  String? _error;

  PostEditor get _editor => ref.read(postEditorProvider(widget.draftId));

  String _stepName(PostStep step, AppLocalizations l10n) => switch (step) {
    PostStep.category => l10n.postStepCategory,
    PostStep.details => l10n.postStepDetails,
    PostStep.photos => l10n.postStepPhotos,
    PostStep.location => l10n.postStepLocation,
    PostStep.contact => l10n.postStepContact,
    PostStep.preview => l10n.postStepPreview,
  };

  Future<void> _next() async {
    final draft = _editor.draft!;
    final l10n = AppLocalizations.of(context)!;
    if (draft.step == PostStep.category && draft.category == null) {
      setState(() => _error = l10n.postCategoryRequired);
      return;
    }
    if (!_gate.passes) return;
    setState(() => _error = null);
    if (draft.step == PostStep.preview) return _submit();
    await _editor.goTo(PostStep.values[draft.step.index + 1]);
  }

  Future<void> _back() async {
    final step = _editor.draft!.step;
    if (step.index == 0) return _close();
    setState(() => _error = null);
    await _editor.goTo(PostStep.values[step.index - 1]);
  }

  Future<void> _close() async {
    await _editor.flush();
    if (!mounted) return;
    final draft = _editor.draft;
    if (draft != null && draft.hasContent) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context)!.postDraftKept)),
      );
    }
    context.pop();
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final wasEdit = _editor.draft!.isEdit;
    final outcome = await _editor.submit();
    if (!mounted) return;
    switch (outcome) {
      case SubmitAccepted(:final post):
        context.pushReplacement(
          RoutePaths.postResult,
          extra: PostResultArgs(post: post, wasEdit: wasEdit),
        );
      case SubmitQueued():
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l10n.postQueuedOffline)));
        context.pop();
      case SubmitPhotosFailed():
        final failed =
            _editor.photos.items.length - _editor.photos.mediaIds.length;
        setState(
          () =>
              _error = l10n.postPhotosFailed(localizeDigits('$failed', locale)),
        );
        await _editor.goTo(PostStep.photos);
      case SubmitRejected(:final error):
        setState(() => _error = describePostError(error, l10n, locale));
        if (_stepFor(error) case final step?) await _editor.goTo(step);
    }
  }

  /// Where the user can fix what the server refused.
  PostStep? _stepFor(AppException error) {
    if (error is! ApiException) return null;
    final paths = error.validationIssues?.map((i) => i.path).join(' ') ?? '';
    return switch (error.code) {
      'FIELD_VALIDATION_FAILED' || 'POST_TEXT_TOO_LONG' => PostStep.details,
      'POST_MEDIA_INVALID' ||
      'POST_MEDIA_TENANT_MISMATCH' ||
      'POST_TOO_MANY_MEDIA' ||
      'UPLOAD_MISSING' ||
      'UPLOAD_REJECTED' => PostStep.photos,
      'LOCATION_NOT_FOUND' => PostStep.location,
      'CATEGORY_NOT_POSTABLE' || 'CATEGORY_NOT_FOUND' => PostStep.category,
      'VALIDATION_FAILED' when paths.contains('contact') => PostStep.contact,
      _ => null,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final editor = ref.watch(postEditorProvider(widget.draftId));
    return ListenableBuilder(
      listenable: editor,
      builder: (context, _) {
        final draft = editor.draft;
        if (draft == null) {
          return Scaffold(
            appBar: AppBar(),
            body: editor.missing
                ? EmptyState(
                    title: l10n.postErrorNotFound,
                    icon: Icons.drafts_outlined,
                  )
                : const Center(child: CircularProgressIndicator()),
          );
        }
        final step = draft.step;
        final total = PostStep.values.length;
        return PopScope(
          canPop: false,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _back();
          },
          child: Scaffold(
            appBar: AppBar(
              title: Text(
                draft.isEdit
                    ? l10n.postEditorTitleEdit
                    : l10n.postEditorTitleNew,
              ),
              leading: IconButton(
                tooltip: l10n.postCancel,
                icon: const Icon(Icons.close),
                onPressed: _close,
              ),
              bottom: PreferredSize(
                preferredSize: const Size.fromHeight(28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.md,
                      ),
                      child: Text(
                        l10n.postStepProgress(
                          localizeDigits('${step.index + 1}', locale),
                          localizeDigits('$total', locale),
                          _stepName(step, l10n),
                        ),
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    LinearProgressIndicator(value: (step.index + 1) / total),
                  ],
                ),
              ),
            ),
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error case final error?)
                  MaterialBanner(
                    key: const ValueKey('editor-error'),
                    content: Text(error),
                    leading: Icon(
                      Icons.error_outline,
                      color: Theme.of(context).colorScheme.error,
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => setState(() => _error = null),
                        child: Text(l10n.postCancel),
                      ),
                    ],
                  ),
                Expanded(child: _stepBody(editor, step)),
              ],
            ),
            bottomNavigationBar: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Row(
                  children: [
                    if (step.index > 0) ...[
                      Expanded(
                        child: AppButton(
                          label: l10n.postBack,
                          variant: AppButtonVariant.secondary,
                          onPressed: editor.submitting ? null : _back,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                    ],
                    if (step != PostStep.category)
                      Expanded(
                        flex: 2,
                        child: AppButton(
                          key: const ValueKey('editor-next'),
                          label: step == PostStep.preview
                              ? _submitLabel(draft, l10n)
                              : l10n.postNext,
                          isLoading: editor.submitting,
                          onPressed: _next,
                        ),
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

  String _submitLabel(PostDraft draft, AppLocalizations l10n) =>
      switch (draft.originalStatus) {
        null => l10n.postSubmitButton,
        'rejected' || 'removed' => l10n.postResubmitButton,
        _ => l10n.postSaveChangesButton,
      };

  Widget _stepBody(PostEditor editor, PostStep step) => switch (step) {
    PostStep.category => CategoryStep(editor: editor, onPicked: _next),
    PostStep.details => DetailsStep(editor: editor, gate: _gate),
    PostStep.photos => PhotosStep(editor: editor, picker: widget.picker),
    PostStep.location => LocationStep(editor: editor, gate: _gate),
    PostStep.contact => ContactStep(editor: editor, gate: _gate),
    PostStep.preview => PreviewStep(editor: editor),
  };
}
