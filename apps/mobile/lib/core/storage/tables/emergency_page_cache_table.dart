import 'package:drift/drift.dart';

/// The whole emergency page (GET /info/emergency, ADR 064) per area, as
/// JSON: national hotlines and the local contacts near the area. The one
/// screen that must open with no network, so it is read from here first and
/// refreshed in the background (`refreshAfterSeconds`).
@DataClassName('EmergencyPageCacheRow')
class EmergencyPageCache extends Table {
  TextColumn get tenantId => text()();
  TextColumn get version => text()();
  TextColumn get json => text()();
  DateTimeColumn get fetchedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {tenantId};
}
