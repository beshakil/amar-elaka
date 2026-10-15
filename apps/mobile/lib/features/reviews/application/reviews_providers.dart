import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../../my_store/application/my_store_providers.dart';
import '../data/review_models.dart';
import '../data/reviews_api.dart';

class StoreReviewsState {
  const StoreReviewsState({
    required this.summary,
    required this.items,
    required this.nextBefore,
    this.loadingMore = false,
  });

  final ReviewSummary summary;
  final List<StoreReview> items;
  final String? nextBefore;
  final bool loadingMore;

  bool get hasMore => nextBefore != null;

  StoreReviewsState copyWith({
    List<StoreReview>? items,
    String? nextBefore,
    bool clearNext = false,
    bool? loadingMore,
  }) => StoreReviewsState(
    summary: summary,
    items: items ?? this.items,
    nextBefore: clearNext ? null : (nextBefore ?? this.nextBefore),
    loadingMore: loadingMore ?? this.loadingMore,
  );
}

/// A store's published reviews (ADR 061), newest first, with the summary
/// and the seller tier; older pages on demand.
class StoreReviewsController extends AsyncNotifier<StoreReviewsState> {
  StoreReviewsController(this.storeId);

  final String storeId;

  ReviewsApi get _api => ref.read(reviewsApiProvider);

  @override
  Future<StoreReviewsState> build() async {
    final page = await ref.watch(reviewsApiProvider).page(storeId);
    return StoreReviewsState(
      summary: page.summary,
      items: page.items,
      nextBefore: page.nextBefore,
    );
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final page = await _api.page(storeId, before: current.nextBefore);
      state = AsyncData(
        current.copyWith(
          items: [...current.items, ...page.items],
          nextBefore: page.nextBefore,
          clearNext: page.nextBefore == null,
          loadingMore: false,
        ),
      );
    } on Object {
      state = AsyncData(current.copyWith(loadingMore: false));
    }
  }

  /// The store replied (or edited its reply): show it without a reload.
  Future<void> respond(String reviewId, String text) async {
    await _api.respond(storeId, reviewId, text);
    final current = state.value;
    if (current == null) return;
    final now = DateTime.now();
    state = AsyncData(
      current.copyWith(
        items: [
          for (final r in current.items)
            r.id == reviewId
                ? StoreReview(
                    id: r.id,
                    rating: r.rating,
                    text: r.text,
                    authorName: r.authorName,
                    authorRemoved: r.authorRemoved,
                    createdAt: r.createdAt,
                    editedAt: r.editedAt,
                    photos: r.photos,
                    response: ReviewResponse(
                      text: text.trim(),
                      createdAt: r.response?.createdAt ?? now,
                      editedAt: r.response == null ? null : now,
                    ),
                  )
                : r,
        ],
      ),
    );
  }
}

final storeReviewsProvider = AsyncNotifierProvider.autoDispose
    .family<StoreReviewsController, StoreReviewsState, String>(
      StoreReviewsController.new,
    );

/// May the signed-in user review this store (the anti-fake rule), and their review.
final reviewEligibilityProvider = FutureProvider.autoDispose
    .family<ReviewEligibility, String>((ref, storeId) {
      if (ref.watch(authControllerProvider) is! AuthSessionAuthenticated) {
        return const ReviewEligibility(status: EligibilityStatus.signedOut);
      }
      return ref.watch(reviewsApiProvider).eligibility(storeId);
    });

/// Whether the signed-in user may reply for this store: its owner or an
/// accepted manager (the API decides; this only shows the button).
final managesStoreProvider = FutureProvider.autoDispose.family<bool, String>((
  ref,
  storeId,
) async {
  if (ref.watch(authControllerProvider) is! AuthSessionAuthenticated) {
    return false;
  }
  try {
    final mine = await ref.watch(myStoresProvider.future);
    return mine.any(
      (s) =>
          s.id == storeId &&
          s.accepted &&
          (s.role == 'owner' || s.role == 'manager'),
    );
  } on Object {
    return false;
  }
});
