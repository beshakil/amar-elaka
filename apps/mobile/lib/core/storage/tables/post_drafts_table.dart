import 'package:drift/drift.dart';

/// A post being written or edited on this phone — the source of truth until
/// the server has it (docs/decisions/032-mobile-post-flows.md). Saved on
/// every change, so nothing typed is lost to an app kill, a dead battery or
/// no signal. Photos live in the upload queue keyed `post-draft:<id>`.
@DataClassName('PostDraftRow')
class PostDrafts extends Table {
  /// Local id (random); also the upload queue's key.
  TextColumn get id => text()();

  /// Set when editing an existing post, or once the server accepted it.
  TextColumn get serverPostId => text().nullable()();

  /// The post's status when an edit began (live, rejected…); null for a new post.
  TextColumn get originalStatus => text().nullable()();
  IntColumn get step => integer().withDefault(const Constant(0))();

  /// The whole GET /categories item, so a draft reopens offline.
  TextColumn get categoryJson => text().nullable()();
  TextColumn get title => text().withDefault(const Constant(''))();
  TextColumn get description => text().withDefault(const Constant(''))();

  /// The dynamic form's raw state (what was typed), JSON.
  TextColumn get formStateJson => text().withDefault(const Constant('{}'))();

  /// Photos the post already has on the server (edit), JSON list of PostMedia.
  TextColumn get existingMediaJson =>
      text().withDefault(const Constant('[]'))();
  RealColumn get lat => real().nullable()();
  RealColumn get lng => real().nullable()();
  TextColumn get addressLabel => text().nullable()();
  TextColumn get contactName => text().withDefault(const Constant(''))();
  TextColumn get contactPhone => text().withDefault(const Constant(''))();
  BoolColumn get showPhone => boolean().withDefault(const Constant(true))();
  BoolColumn get allowChat => boolean().withDefault(const Constant(true))();
  BoolColumn get showWhatsapp => boolean().withDefault(const Constant(false))();

  /// Sent as Idempotency-Key: a retried submit can never post twice.
  TextColumn get idempotencyKey => text()();

  /// editing | queued (submit when back online) | submitting | submitted
  TextColumn get submitState => text().withDefault(const Constant('editing'))();

  /// The API error code of the last failed submit, for its Bengali message.
  TextColumn get lastErrorCode => text().nullable()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}
