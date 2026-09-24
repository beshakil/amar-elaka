import 'package:drift/drift.dart';

/// Placeholder only: `apps/api` has no feed endpoint yet, so there's no
/// repository/query built on this table — it exists so the shape is ready
/// when that feature lands, per the Week 3 client-shell scope.
class FeedCache extends Table {
  TextColumn get id => text()();
  TextColumn get tenantId => text()();
  TextColumn get payload => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}
