import 'package:drift/drift.dart';

/// A field agent's capture not yet settled with the server (ADR 066): the
/// offline outbox of agent mode, and the source of truth until the sync
/// answers. Written the moment the agent saves (no network needed); the id
/// is made when the capture began and is the server's idempotency key, so a
/// retried or doubled sync never makes a second shop.
@DataClassName('AgentCaptureRow')
class AgentCaptures extends Table {
  /// The submission's UUID (the server's primary key for it).
  TextColumn get id => text()();
  TextColumn get tenantId => text()();

  /// new_shop | verify_shop | update_info.
  TextColumn get kind => text()();

  /// The submission as the API takes it, without photoIds (added at sync).
  TextColumn get payloadJson => text()();

  /// The shop's name, for the queue list (also in the payload).
  TextColumn get title => text()();
  DateTimeColumn get capturedAt => dateTime()();

  /// queued | needs_decision | done | refused.
  TextColumn get state => text().withDefault(const Constant('queued'))();
  IntColumn get attempts => integer().withDefault(const Constant(0))();

  /// When a failed attempt may be retried (null = now).
  DateTimeColumn get nextAttemptAt => dateTime().nullable()();

  /// The API's error code (and reason) when refused, or `network`.
  TextColumn get errorCode => text().nullable()();
  TextColumn get errorReason => text().nullable()();

  /// needs_decision: the shops already on the map ([{placeId, nameBn, distanceM…}]).
  TextColumn get candidatesJson => text().nullable()();

  /// The agent's answer: {decision: 'new'} | {decision: 'same', placeId}.
  TextColumn get decisionJson => text().nullable()();

  /// done: what it became, and the anti-fraud flags the server found.
  TextColumn get placeId => text().nullable()();
  TextColumn get fraudFlagsJson => text().nullable()();
  DateTimeColumn get syncedAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// One photo of a capture, and how far its upload got — each step is saved,
/// so a sync cut off mid-way resumes from the last finished one.
@DataClassName('AgentCapturePhotoRow')
class AgentCapturePhotos extends Table {
  TextColumn get captureId => text()();
  IntColumn get position => integer()();

  /// The compressed copy, kept in the app's support directory until done.
  TextColumn get localPath => text()();
  IntColumn get byteSize => integer()();
  TextColumn get sha256 => text()();

  /// none | presigned | uploaded | ready.
  TextColumn get stage => text().withDefault(const Constant('none'))();
  TextColumn get mediaId => text().nullable()();
  TextColumn get uploadUrl => text().nullable()();
  TextColumn get uploadHeadersJson => text().nullable()();

  @override
  Set<Column> get primaryKey => {captureId, position};
}
