import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/connectivity_provider.dart';
import '../../media_upload/application/upload_queue.dart';
import '../data/post_draft_store.dart';
import 'post_editor.dart';
import 'post_submitter.dart';

/// Sends drafts that were submitted without a connection, as soon as there
/// is one — with their own Idempotency-Key, so a post the server did get
/// (only the answer was lost) comes back as itself, never as a second post.
/// Started once by the app shell; also run on demand ([sendQueued]).
class DraftSync {
  DraftSync(this._ref);

  final Ref _ref;
  bool _running = false;

  /// Accepted posts, for a "your post was sent" message wherever it's shown.
  final StreamController<SubmitAccepted> _sent = StreamController.broadcast();
  Stream<SubmitAccepted> get sent => _sent.stream;

  Future<void> sendQueued() async {
    if (_running) return;
    _running = true;
    try {
      final drafts = await _ref.read(postDraftStoreProvider).queued();
      for (final draft in drafts) {
        // Holds the draft's photo queue open (shared with an open editor).
        final photos = _ref.listen(
          uploadQueueProvider(draft.uploadQueueId),
          (_, _) {},
        );
        try {
          final outcome = await _ref
              .read(postSubmitterProvider)
              .submit(draft, photos.read());
          if (outcome is SubmitAccepted) _sent.add(outcome);
          if (outcome is SubmitQueued) break; // still offline: stop for now
        } finally {
          photos.close();
        }
      }
    } finally {
      _running = false;
    }
  }

  void dispose() => _sent.close();
}

final draftSyncProvider = Provider<DraftSync>((ref) {
  final sync = DraftSync(ref);
  ref.listen(isOnlineProvider, (previous, next) {
    if (next.value == true && previous?.value != true) {
      unawaited(sync.sendQueued());
    }
  }, fireImmediately: true);
  ref.onDispose(sync.dispose);
  return sync;
});
