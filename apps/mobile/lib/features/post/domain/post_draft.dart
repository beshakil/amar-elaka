import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';

import '../../../core/dynamic_form/field_schema.dart';
import 'post_step.dart';

/// Where a draft stands on its way to the server.
enum DraftSubmitState {
  /// Being written; lives only on this phone.
  editing,

  /// Submitted while offline (or the network failed): sent automatically,
  /// with the same Idempotency-Key, as soon as there's a connection.
  queued,

  /// A request is in flight.
  submitting,

  /// The server has it; the draft is kept only until the result is shown.
  submitted,
}

/// A post being written or edited, as saved in Drift (`PostDrafts`). Immutable;
/// every change is a [copyWith] the editor saves.
class PostDraft {
  const PostDraft({
    required this.id,
    required this.idempotencyKey,
    required this.createdAt,
    required this.updatedAt,
    this.serverPostId,
    this.originalStatus,
    this.step = PostStep.category,
    this.category,
    this.title = '',
    this.description = '',
    this.formState = const {},
    this.existingMedia = const [],
    this.lat,
    this.lng,
    this.addressLabel,
    this.contactName = '',
    this.contactPhone = '',
    this.showPhone = true,
    this.allowChat = true,
    this.showWhatsapp = false,
    this.submitState = DraftSubmitState.editing,
    this.lastErrorCode,
  });

  final String id;
  final String idempotencyKey;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Set for an edit of an existing post.
  final String? serverPostId;
  final String? originalStatus;
  final PostStep step;
  final CatalogCategory? category;
  final String title;
  final String description;

  /// The dynamic form's raw state (what was typed).
  final Map<String, Object?> formState;

  /// Photos the post already has on the server (edit only), in order.
  final List<PostMedia> existingMedia;
  final double? lat;
  final double? lng;
  final String? addressLabel;
  final String contactName;

  /// E.164 (+8801…), as the API takes it.
  final String contactPhone;
  final bool showPhone;
  final bool allowChat;
  final bool showWhatsapp;
  final DraftSubmitState submitState;
  final String? lastErrorCode;

  bool get isEdit => serverPostId != null;
  bool get hasLocation => lat != null && lng != null;

  /// The photo upload queue for this draft (UploadQueue's persistent store).
  String get uploadQueueId => 'post-draft:$id';

  /// The category's form schema; null for a module tile or no category yet.
  CategoryFieldSchema? get schema => switch (category?.fieldSchema) {
    final Map<String, dynamic> json => CategoryFieldSchema.fromJson(json),
    null => null,
  };

  /// Something worth resuming (not just an opened, empty editor).
  bool get hasContent =>
      category != null ||
      title.trim().isNotEmpty ||
      description.trim().isNotEmpty ||
      formState.isNotEmpty;

  PostDraft copyWith({
    String? serverPostId,
    PostStep? step,
    CatalogCategory? category,
    bool clearCategory = false,
    String? title,
    String? description,
    Map<String, Object?>? formState,
    List<PostMedia>? existingMedia,
    double? lat,
    double? lng,
    String? addressLabel,
    String? contactName,
    String? contactPhone,
    bool? showPhone,
    bool? allowChat,
    bool? showWhatsapp,
    DraftSubmitState? submitState,
    String? lastErrorCode,
    bool clearError = false,
    DateTime? updatedAt,
  }) => PostDraft(
    id: id,
    idempotencyKey: idempotencyKey,
    createdAt: createdAt,
    updatedAt: updatedAt ?? DateTime.now(),
    serverPostId: serverPostId ?? this.serverPostId,
    originalStatus: originalStatus,
    step: step ?? this.step,
    category: clearCategory ? null : (category ?? this.category),
    title: title ?? this.title,
    description: description ?? this.description,
    formState: formState ?? this.formState,
    existingMedia: existingMedia ?? this.existingMedia,
    lat: lat ?? this.lat,
    lng: lng ?? this.lng,
    addressLabel: addressLabel ?? this.addressLabel,
    contactName: contactName ?? this.contactName,
    contactPhone: contactPhone ?? this.contactPhone,
    showPhone: showPhone ?? this.showPhone,
    allowChat: allowChat ?? this.allowChat,
    showWhatsapp: showWhatsapp ?? this.showWhatsapp,
    submitState: submitState ?? this.submitState,
    lastErrorCode: clearError ? null : (lastErrorCode ?? this.lastErrorCode),
  );

  static String encodeFormState(Map<String, Object?> state) =>
      jsonEncode(state);

  static Map<String, Object?> decodeFormState(String raw) =>
      Map<String, Object?>.from(jsonDecode(raw) as Map);
}
