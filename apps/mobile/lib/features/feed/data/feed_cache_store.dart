import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';

/// A cached first page: the body as the API sent it, and when.
typedef CachedFeedPage = ({String rawJson, DateTime cachedAt});

/// The first page of each feed query, kept in Drift (`FeedCache`) so the
/// app opens offline onto the last feed it saw — never a blank screen.
/// Later pages aren't kept: they're a scroll away from a fresh first page.
abstract interface class FeedCacheStore {
  Future<CachedFeedPage?> read(String tenantId, String key);
  Future<void> write(String tenantId, String key, String rawJson);
}

class DriftFeedCacheStore implements FeedCacheStore {
  DriftFeedCacheStore(this._db);

  final AppDatabase _db;

  // The row id carries the tenant: switching area never shows another
  // area's feed.
  String _id(String tenantId, String key) => '$tenantId|$key';

  @override
  Future<CachedFeedPage?> read(String tenantId, String key) async {
    final row = await (_db.select(
      _db.feedCache,
    )..where((t) => t.id.equals(_id(tenantId, key)))).getSingleOrNull();
    return row == null ? null : (rawJson: row.payload, cachedAt: row.cachedAt);
  }

  @override
  Future<void> write(String tenantId, String key, String rawJson) => _db
      .into(_db.feedCache)
      .insertOnConflictUpdate(
        FeedCacheCompanion.insert(
          id: _id(tenantId, key),
          tenantId: tenantId,
          payload: rawJson,
          cachedAt: DateTime.now(),
        ),
      );
}

final feedCacheStoreProvider = Provider<FeedCacheStore>(
  (ref) => DriftFeedCacheStore(ref.watch(appDatabaseProvider)),
);
