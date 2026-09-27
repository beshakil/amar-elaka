import 'package:drift/drift.dart';

/// The first page of each feed query, as the API sent it
/// (features/feed/data/feed_cache_store.dart): `id` is `<tenant>|<query>`.
class FeedCache extends Table {
  TextColumn get id => text()();
  TextColumn get tenantId => text()();
  TextColumn get payload => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}
