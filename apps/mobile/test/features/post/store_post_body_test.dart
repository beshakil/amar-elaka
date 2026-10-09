import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/post/application/post_submitter.dart';
import 'package:amar_elaka_app/features/post/domain/post_draft.dart';
import 'package:flutter_test/flutter_test.dart';

/// Posting as a store (ADR 057): the create body names the store; an edit
/// never does (a post doesn't move between stores).
void main() {
  final now = DateTime.utc(2026, 10, 9);
  PostDraft draft({String? serverPostId}) => PostDraft(
    id: 'd1',
    idempotencyKey: 'k1',
    createdAt: now,
    updatedAt: now,
    serverPostId: serverPostId,
    category: const CatalogCategory(
      id: 'c1',
      parentId: null,
      slug: 'mobile-phones',
      kind: 'marketplace',
      name: LocalizedName(bn: 'মোবাইল', en: 'Phones'),
      iconKey: null,
      postExpiryDays: null,
      requiresApproval: false,
      fieldSchema: null,
    ),
    title: 'চাল',
    lat: 23.8,
    lng: 90.4,
    storeId: 's1',
  );

  test('a new post as a store carries the store', () {
    expect(PostSubmitter.requestBody(draft(), const [])['storeId'], 's1');
  });

  test('an edit never sends it, and clearing it makes a personal post', () {
    expect(
      PostSubmitter.requestBody(
        draft(serverPostId: 'p1'),
        const [],
      ).containsKey('storeId'),
      isFalse,
    );
    expect(
      PostSubmitter.requestBody(
        draft().copyWith(clearStore: true),
        const [],
      ).containsKey('storeId'),
      isFalse,
    );
  });
}
