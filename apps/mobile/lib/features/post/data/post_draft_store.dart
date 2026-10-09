import 'dart:convert';
import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/dynamic_form/field_schema.dart';
import '../../../core/dynamic_form/form_values.dart';
import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';
import '../domain/post_draft.dart';
import '../domain/post_step.dart';

/// Drafts in Drift (`PostDrafts`): written on every change, read back after
/// an app kill. The only place the editor persists to.
class PostDraftStore {
  PostDraftStore(this._db, {String Function()? newToken})
    : _newToken = newToken ?? randomToken;

  final AppDatabase _db;
  final String Function() _newToken;

  /// A new, empty draft; contact defaults come from the signed-in profile.
  Future<PostDraft> createNew({
    required String contactName,
    required String contactPhone,
  }) async {
    final now = DateTime.now();
    final draft = PostDraft(
      id: _newToken(),
      idempotencyKey: 'post-${_newToken()}',
      createdAt: now,
      updatedAt: now,
      contactName: contactName,
      contactPhone: contactPhone,
    );
    await save(draft);
    return draft;
  }

  /// A draft that edits [post]; opens at the details step (the category is
  /// already chosen), with its current values as the form shows them.
  Future<PostDraft> createEdit(
    PostView post,
    CatalogCategory? category, {
    required String locale,
  }) async {
    final existing = await _editOf(post.id);
    if (existing != null) return existing;
    final now = DateTime.now();
    final draft = PostDraft(
      id: _newToken(),
      idempotencyKey: 'post-${_newToken()}',
      createdAt: now,
      updatedAt: now,
      serverPostId: post.id,
      originalStatus: post.status,
      step: PostStep.details,
      category: category,
      title: post.title,
      description: post.description ?? '',
      formState: switch (category?.fieldSchema) {
        final Map<String, dynamic> json => valuesToFormState(
          CategoryFieldSchema.fromJson(json),
          post.fields,
          locale,
        ),
        null => const {},
      },
      existingMedia: post.media,
      lat: post.location?.lat,
      lng: post.location?.lng,
      contactName: post.contact.name ?? '',
      contactPhone: post.contact.phone ?? '',
      showPhone: post.showPhone,
      allowChat: post.allowChat,
      showWhatsapp: post.showWhatsapp,
    );
    await save(draft);
    return draft;
  }

  Future<PostDraft?> load(String id) async {
    final row = await (_db.select(
      _db.postDrafts,
    )..where((t) => t.id.equals(id))).getSingleOrNull();
    return row == null ? null : _fromRow(row);
  }

  /// Drafts not yet on the server (or waiting to be sent), newest first.
  Stream<List<PostDraft>> watchUnfinished() {
    final query = _db.select(_db.postDrafts)
      ..where((t) => t.submitState.isNotValue(DraftSubmitState.submitted.name))
      ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)]);
    return query.watch().map((rows) => rows.map(_fromRow).toList());
  }

  Future<List<PostDraft>> queued() async {
    final rows = await (_db.select(
      _db.postDrafts,
    )..where((t) => t.submitState.equals(DraftSubmitState.queued.name))).get();
    return rows.map(_fromRow).toList();
  }

  Future<void> save(PostDraft draft) => _db
      .into(_db.postDrafts)
      .insertOnConflictUpdate(
        PostDraftsCompanion.insert(
          id: draft.id,
          serverPostId: Value(draft.serverPostId),
          originalStatus: Value(draft.originalStatus),
          step: Value(draft.step.index),
          categoryJson: Value(
            draft.category == null
                ? null
                : jsonEncode(draft.category!.toJson()),
          ),
          title: Value(draft.title),
          description: Value(draft.description),
          formStateJson: Value(PostDraft.encodeFormState(draft.formState)),
          existingMediaJson: Value(
            jsonEncode([for (final m in draft.existingMedia) m.toJson()]),
          ),
          lat: Value(draft.lat),
          lng: Value(draft.lng),
          addressLabel: Value(draft.addressLabel),
          contactName: Value(draft.contactName),
          contactPhone: Value(draft.contactPhone),
          showPhone: Value(draft.showPhone),
          allowChat: Value(draft.allowChat),
          showWhatsapp: Value(draft.showWhatsapp),
          storeId: Value(draft.storeId),
          idempotencyKey: draft.idempotencyKey,
          submitState: Value(draft.submitState.name),
          lastErrorCode: Value(draft.lastErrorCode),
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        ),
      );

  Future<void> delete(String id) =>
      (_db.delete(_db.postDrafts)..where((t) => t.id.equals(id))).go();

  Future<PostDraft?> _editOf(String serverPostId) async {
    final row =
        await (_db.select(_db.postDrafts)
              ..where((t) => t.serverPostId.equals(serverPostId))
              ..where(
                (t) =>
                    t.submitState.isNotValue(DraftSubmitState.submitted.name),
              ))
            .getSingleOrNull();
    return row == null ? null : _fromRow(row);
  }

  PostDraft _fromRow(PostDraftRow row) => PostDraft(
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverPostId: row.serverPostId,
    originalStatus: row.originalStatus,
    step: PostStep.values[row.step.clamp(0, PostStep.values.length - 1)],
    category: row.categoryJson == null
        ? null
        : CatalogCategory.fromJson(
            jsonDecode(row.categoryJson!) as Map<String, dynamic>,
          ),
    title: row.title,
    description: row.description,
    formState: PostDraft.decodeFormState(row.formStateJson),
    existingMedia: [
      for (final m in jsonDecode(row.existingMediaJson) as List)
        PostMedia.fromJson(m as Map<String, dynamic>),
    ],
    lat: row.lat,
    lng: row.lng,
    addressLabel: row.addressLabel,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    showPhone: row.showPhone,
    allowChat: row.allowChat,
    showWhatsapp: row.showWhatsapp,
    storeId: row.storeId,
    submitState: DraftSubmitState.values.firstWhere(
      (s) => s.name == row.submitState,
      orElse: () => DraftSubmitState.editing,
    ),
    lastErrorCode: row.lastErrorCode,
  );
}

/// 128 random bits as hex: draft ids and Idempotency-Keys.
String randomToken() {
  final random = math.Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

final postDraftStoreProvider = Provider<PostDraftStore>(
  (ref) => PostDraftStore(ref.watch(appDatabaseProvider)),
);
