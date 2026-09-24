// amar_elaka_api and json_list_converter aren't referenced by name below —
// they're needed for `TenantCategory`/`StringListConverter`, which the
// generated `app_database.g.dart` (a `part of` this file, so it only sees
// *this* file's imports, not what the table files below imported) uses
// through the tables' `TypeConverter`s.
import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

import 'json_list_converter.dart';
import 'tables/emergency_contact_table.dart';
import 'tables/feed_cache_table.dart';
import 'tables/tenant_config_table.dart';

part 'app_database.g.dart';

/// Local cache — tenant config, emergency contacts, and a feed-cache
/// placeholder (see `FeedCache`). Nothing here is a source of truth; every
/// row is a cached copy of a server response, refreshed on bootstrap.
@DriftDatabase(tables: [TenantConfigCache, EmergencyContactCache, FeedCache])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(driftDatabase(name: 'amar_elaka'));

  /// For tests: an in-memory database instead of a file on disk.
  AppDatabase.forTesting(super.executor);

  @override
  int get schemaVersion => 1;
}
