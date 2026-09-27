import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../media_upload/application/upload_queue.dart';
import '../data/post_draft_store.dart';
import '../data/posts_api.dart';
import '../domain/post_draft.dart';
import '../domain/post_step.dart';
import 'post_submitter.dart';

/// Autosave debounce: long enough not to write on every keystroke, short
/// enough that an app kill loses at most a few characters (and a lifecycle
/// pause flushes at once anyway).
const draftSaveDebounce = Duration(milliseconds: 400);

/// One draft being edited: its state, autosave, step navigation and submit.
/// Screens listen to it (ListenableBuilder); every change is saved to Drift
/// after [draftSaveDebounce], at once on a step change, and at once when the
/// app goes to the background — nothing typed is lost to an app kill.
class PostEditor extends ChangeNotifier with WidgetsBindingObserver {
  PostEditor({
    required this.draftId,
    required this._store,
    required this._submitter,
    required this.photos,
  }) {
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  final String draftId;
  final UploadQueue photos;
  final PostDraftStore _store;
  final PostSubmitter _submitter;

  PostDraft? _draft;
  bool _missing = false;
  bool _submitting = false;
  Timer? _saveTimer;
  bool _disposed = false;

  /// The server has the post and the draft is deleted: never save it again
  /// (a late flush would bring the submitted draft back).
  bool _finished = false;

  /// Null while loading (or when the draft no longer exists — see [missing]).
  PostDraft? get draft => _draft;

  /// The draft was submitted or discarded elsewhere.
  bool get missing => _missing;
  bool get submitting => _submitting;

  Future<void> _load() async {
    final loaded = await _store.load(draftId);
    if (_disposed) return;
    _draft = loaded;
    _missing = loaded == null;
    notifyListeners();
  }

  /// Applies [change] and schedules the save.
  void update(PostDraft Function(PostDraft draft) change) {
    final current = _draft;
    if (current == null || _finished) return;
    _draft = change(current);
    notifyListeners();
    _saveTimer?.cancel();
    _saveTimer = Timer(draftSaveDebounce, flush);
  }

  /// Saves now (a step change, the app going to the background, leaving).
  Future<void> flush() async {
    _saveTimer?.cancel();
    _saveTimer = null;
    final current = _draft;
    if (current != null && !_finished) await _store.save(current);
  }

  Future<void> goTo(PostStep step) async {
    update((d) => d.copyWith(step: step));
    await flush();
  }

  /// Picking another category clears the old one's form values (their keys
  /// mean nothing in the new schema); title, description and photos stay.
  void chooseCategory(CatalogCategory category) => update(
    (d) => d.category?.id == category.id
        ? d
        : d.copyWith(category: category, formState: const {}),
  );

  Future<SubmitOutcome> submit() async {
    final current = _draft;
    if (current == null || _submitting) return const SubmitQueued();
    await flush();
    _submitting = true;
    notifyListeners();
    try {
      final outcome = await _submitter.submit(current, photos);
      if (outcome is SubmitAccepted) {
        _finished = true;
      } else {
        _draft = await _store.load(draftId) ?? current;
      }
      return outcome;
    } finally {
      _submitting = false;
      if (!_disposed) notifyListeners();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(flush());
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(flush());
    super.dispose();
  }
}

final postSubmitterProvider = Provider<PostSubmitter>(
  (ref) => PostSubmitter(
    ref.watch(postsApiProvider),
    ref.watch(postDraftStoreProvider),
  ),
);

/// One editor per open draft; its photo queue is shared with [DraftSync].
final postEditorProvider = Provider.autoDispose.family<PostEditor, String>((
  ref,
  draftId,
) {
  final editor = PostEditor(
    draftId: draftId,
    store: ref.watch(postDraftStoreProvider),
    submitter: ref.watch(postSubmitterProvider),
    photos: ref.watch(uploadQueueProvider('post-draft:$draftId')),
  );
  ref.onDispose(editor.dispose);
  return editor;
});

/// The categories that can take a post in this tenant (GET /categories,
/// minus module tiles, which have no form).
final postableCategoriesProvider =
    FutureProvider.autoDispose<List<CatalogCategory>>((ref) async {
      final all = await ref.watch(postsApiProvider).categories();
      return [
        for (final category in all)
          if (category.fieldSchema != null) category,
      ];
    });
