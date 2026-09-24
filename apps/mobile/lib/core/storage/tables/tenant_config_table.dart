import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:drift/drift.dart';

/// `List<TenantCategory>` stored as JSON text — `TenantConfig.enabledCategories`
/// doesn't get its own table since it's small, tenant-scoped, and only ever
/// read as a whole list (a picker's category filter), not queried by field.
class EnabledCategoriesConverter
    extends TypeConverter<List<TenantCategory>, String> {
  const EnabledCategoriesConverter();

  @override
  List<TenantCategory> fromSql(String fromDb) {
    final decoded = jsonDecode(fromDb) as List<dynamic>;
    return decoded
        .map((e) => TenantCategory.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  String toSql(List<TenantCategory> value) =>
      jsonEncode(value.map((c) => c.toJson()).toList());
}

/// Caches `GET /tenant/config` (apps/api/src/tenants/tenants.service.ts,
/// `TenantConfig`) for offline bootstrap. One row per tenant the device has
/// ever bootstrapped into.
@DataClassName('TenantConfigCacheRow')
class TenantConfigCache extends Table {
  TextColumn get id => text()();
  TextColumn get slug => text()();
  TextColumn get nameBn => text()();
  TextColumn get nameEn => text()();
  TextColumn get defaultLocale => text()();
  RealColumn get mapCenterLat => real()();
  RealColumn get mapCenterLng => real()();
  RealColumn get radiusKm => real().nullable()();
  TextColumn get logoStorageKey => text().nullable()();
  TextColumn get enabledCategories =>
      text().map(const EnabledCategoriesConverter())();
  TextColumn get supportPhone => text().nullable()();
  TextColumn get supportEmail => text().nullable()();
  TextColumn get supportWhatsapp => text().nullable()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}
