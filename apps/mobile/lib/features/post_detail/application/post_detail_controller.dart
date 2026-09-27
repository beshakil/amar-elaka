import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../feed/application/feed_controller.dart';
import '../data/engagement_api.dart';

/// One post's detail (GET /posts/:id/detail), with the viewer's distance
/// when location is allowed. Opening it counts a view (POST /view), fire
/// and forget: a failed view never affects the screen.
class PostDetailController extends AsyncNotifier<PostDetail> {
  PostDetailController(this.postId);

  final String postId;

  EngagementApi get _api => ref.read(engagementApiProvider);

  @override
  Future<PostDetail> build() async {
    final position = await ref.read(viewerPositionProvider.future);
    final detail = await _api.detail(
      postId,
      lat: position?.latitude,
      lng: position?.longitude,
    );
    if (!detail.isMine) {
      unawaited(_api.view(postId).catchError((Object _) {}));
    }
    return detail;
  }

  /// Save or unsave: the button flips at once and flips back (error
  /// rethrown for a message) if the server refuses. The feed's heart for
  /// the same post follows.
  Future<void> toggleSaved() async {
    final detail = state.value;
    if (detail == null) return;
    final saving = !detail.isSaved;
    _setSaved(saving);
    try {
      await (saving ? _api.save(postId) : _api.unsave(postId));
    } on AppException {
      _setSaved(!saving);
      rethrow;
    }
  }

  void _setSaved(bool saved) {
    final detail = state.value;
    if (detail == null) return;
    state = AsyncData(detail.copyWith(isSaved: saved));
    ref.read(feedControllerProvider.notifier).markSaved(postId, saved: saved);
  }
}

final postDetailProvider = AsyncNotifierProvider.autoDispose
    .family<PostDetailController, PostDetail, String>(PostDetailController.new);
