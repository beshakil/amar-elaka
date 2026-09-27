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
import 'tables/post_drafts_table.dart';
import 'tables/tenant_config_table.dart';

part 'app_database.g.dart';

/// Local cache — tenant config, emergency contacts, and a feed-cache
/// placeholder (see `FeedCache`): cached copies of server responses,
/// refreshed on bootstrap. The one exception is `PostDrafts`, the source of
/// truth for posts not yet on the server.
@DriftDatabase(
  tables: [TenantConfigCache, EmergencyContactCache, FeedCache, PostDrafts],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(driftDatabase(name: 'amar_elaka'));

  /// For tests: an in-memory database instead of a file on disk.
  AppDatabase.forTesting(super.executor);

  @override
  int get schemaVersion => 2;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onUpgrade: (m, from, to) async {
      if (from < 2) {
        await m.createTable(postDrafts);
        await m.addColumn(
          tenantConfigCache,
          tenantConfigCache.typicalReviewHours,
        );
      }
    },
  );
}
