import 'package:drift/drift.dart';

/// A chat message written on this phone that the server hasn't confirmed
/// yet (ADR 060): the offline composer's outbox. The source of truth until
/// the send succeeds — written before the first attempt, so a message typed
/// with no signal, or as the app is killed, still goes out later. The
/// client id is the server's dedupe key: replaying a row never sends twice.
@DataClassName('PendingChatMessageRow')
class PendingChatMessages extends Table {
  /// The client message id (also the server's idempotency key).
  TextColumn get clientMessageId => text()();
  TextColumn get conversationId => text()();

  /// The message content as the API takes it: {kind, body | mediaId | lat,lng | postId}.
  TextColumn get contentJson => text()();

  /// A photo still on the phone: compressed and uploaded before the send.
  TextColumn get localImagePath => text().nullable()();

  /// pending (will be retried) | failed (refused for good: shown with its reason).
  TextColumn get state => text().withDefault(const Constant('pending'))();
  IntColumn get attempts => integer().withDefault(const Constant(0))();

  /// The API's error code when refused (CHAT_CONTACT_INFO_BLOCKED, CHAT_BLOCKED…).
  TextColumn get errorCode => text().nullable()();
  DateTimeColumn get createdAt => dateTime()();

  @override
  Set<Column> get primaryKey => {clientMessageId};
}
