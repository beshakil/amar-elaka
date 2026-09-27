import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';

import '../../../core/dynamic_form/form_values.dart';
import '../../../core/network/api_exception.dart';
import '../../media_upload/application/upload_queue.dart';
import '../data/post_draft_store.dart';
import '../data/posts_api.dart';
import '../domain/post_draft.dart';

/// What a submit came to.
sealed class SubmitOutcome {
  const SubmitOutcome();
}

/// The server has it: `post.status` says live or pending.
final class SubmitAccepted extends SubmitOutcome {
  const SubmitAccepted(this.post);
  final PostView post;
}

/// No connection: saved as `queued`, sent by [DraftSync] once back online.
final class SubmitQueued extends SubmitOutcome {
  const SubmitQueued();
}

/// The server said no; the draft is kept (editing) with the error code.
final class SubmitRejected extends SubmitOutcome {
  const SubmitRejected(this.error);
  final AppException error;
}

/// A photo failed to upload: the user retries or removes it first.
final class SubmitPhotosFailed extends SubmitOutcome {
  const SubmitPhotosFailed();
}

/// Sends a draft to the API — for the editor's "post" button and for
/// [DraftSync]'s offline queue alike, so both behave the same:
///
///  1. waits for photos still uploading (a failed one stops the submit);
///  2. a new post: POST /posts {submit: true} with the draft's
///     Idempotency-Key, so a retry after a lost response returns the same
///     post instead of a second one;
///  3. an edit: PATCH, then submit if it was rejected/removed/a draft
///     (resubmission waits for a moderator — ADR 029);
///  4. a network failure queues it; anything else keeps it editable with the
///     error, and the post is never lost either way.
class PostSubmitter {
  PostSubmitter(this._api, this._store);

  final PostsApi _api;
  final PostDraftStore _store;

  Future<SubmitOutcome> submit(PostDraft draft, UploadQueue photos) async {
    await _store.save(
      draft.copyWith(
        submitState: DraftSubmitState.submitting,
        clearError: true,
      ),
    );
    if (!await _photosSettled(photos)) {
      await _store.save(draft.copyWith(submitState: DraftSubmitState.editing));
      return const SubmitPhotosFailed();
    }

    final body = requestBody(draft, photos.mediaIds);
    try {
      final PostView post;
      if (draft.serverPostId case final id?) {
        final updated = await _api.update(id, body);
        post = switch (updated.status) {
          'rejected' || 'removed' || 'draft' => await _api.submit(id),
          _ => updated,
        };
      } else {
        post = await _api.create({
          ...body,
          'submit': true,
        }, idempotencyKey: draft.idempotencyKey);
      }
      await _store.delete(draft.id);
      await photos.clear();
      return SubmitAccepted(post);
    } on AppException catch (error) {
      if (error is NetworkException || error is TimeoutException) {
        await _store.save(draft.copyWith(submitState: DraftSubmitState.queued));
        return const SubmitQueued();
      }
      await _store.save(
        draft.copyWith(
          submitState: DraftSubmitState.editing,
          lastErrorCode: error is ApiException ? error.code : null,
        ),
      );
      return SubmitRejected(error);
    }
  }

  /// The API body (CreatePostDto / UpdatePostDto): categories' fields in API
  /// shape, photos in display order — the post's kept ones, then new uploads.
  static Map<String, Object?> requestBody(
    PostDraft draft,
    List<String> uploadedMediaIds,
  ) {
    final schema = draft.schema;
    final description = draft.description.trim();
    return {
      'categoryId': draft.category!.id,
      'title': draft.title.trim(),
      // Create omits an empty description; an edit clears it with null.
      if (description.isNotEmpty)
        'description': description
      else if (draft.isEdit)
        'description': null,
      'fields': schema == null
          ? const <String, Object>{}
          : formStateToValues(schema, draft.formState),
      'location': {'lat': draft.lat, 'lng': draft.lng},
      'mediaIds': [
        for (final m in draft.existingMedia) m.id,
        ...uploadedMediaIds,
      ],
      'showPhone': draft.showPhone,
      'allowChat': draft.allowChat,
      'showWhatsapp': draft.showWhatsapp,
      if (draft.contactName.trim().isNotEmpty)
        'contactName': draft.contactName.trim(),
      if (draft.contactPhone.isNotEmpty) 'contactPhone': draft.contactPhone,
    };
  }

  /// Waits until no photo is in flight; false if any failed.
  static Future<bool> _photosSettled(UploadQueue photos) async {
    if (photos.isBusy) {
      final settled = Completer<void>();
      void check() {
        if (!photos.isBusy && !settled.isCompleted) settled.complete();
      }

      photos.addListener(check);
      check();
      await settled.future;
      photos.removeListener(check);
    }
    return !photos.hasFailures;
  }
}
