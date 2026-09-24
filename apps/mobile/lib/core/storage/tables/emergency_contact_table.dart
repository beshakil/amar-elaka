import 'package:drift/drift.dart';

import '../json_list_converter.dart';

/// Normalized rows unpacked from `TenantConfig.emergencyNumbers` on every
/// refresh — queryable directly (e.g. by `tenantId`) for the Info tab,
/// rather than buried inside `TenantConfigCache`'s JSON blob.
@DataClassName('EmergencyContactCacheRow')
class EmergencyContactCache extends Table {
  IntColumn get rowId => integer().autoIncrement()();
  TextColumn get tenantId => text()();
  TextColumn get serviceType => text()();
  TextColumn get nameBn => text()();
  TextColumn get nameEn => text().nullable()();
  TextColumn get phones => text().map(const StringListConverter())();
  BoolColumn get is24h => boolean()();
}
