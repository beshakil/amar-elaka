import 'package:drift/drift.dart';

/// The downloaded map area of a tenant (ADR 050): where its archive and
/// style assets are on disk, what it covers and which version it is. One
/// row per tenant; replaced on an update, removed on delete.
@DataClassName('OfflineMapRow')
class OfflineMaps extends Table {
  TextColumn get tenantId => text()();

  /// The national version it was cut from (an update = a different one).
  TextColumn get version => text()();
  TextColumn get archivePath => text()();

  /// The directory the style's fonts/… and sprites/… live under.
  TextColumn get assetsDir => text()();
  TextColumn get areasPath => text().nullable()();
  IntColumn get bytes => integer()();
  TextColumn get sha256 => text()();
  IntColumn get maxZoom => integer()();
  RealColumn get minLng => real()();
  RealColumn get minLat => real()();
  RealColumn get maxLng => real()();
  RealColumn get maxLat => real()();

  /// `map_label_language` when downloaded: the offline style needs no `/map/config`.
  TextColumn get labelLanguage => text()();
  IntColumn get updateCheckHours => integer()();
  DateTimeColumn get downloadedAt => dateTime()();
  DateTimeColumn get checkedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {tenantId};
}

/// Essential points kept for offline use: emergency services, hospitals,
/// pharmacies, landmarks — from our own `GET /map/features`, never Barikoi.
@DataClassName('OfflinePointRow')
class OfflinePoints extends Table {
  IntColumn get rowId => integer().autoIncrement()();
  TextColumn get tenantId => text()();
  TextColumn get featureId => text()();
  TextColumn get featureTenantId => text()();
  TextColumn get layer => text()();
  TextColumn get kind => text().nullable()();
  TextColumn get infoKind => text().nullable()();
  TextColumn get nameBn => text().nullable()();
  TextColumn get nameEn => text().nullable()();
  RealColumn get lat => real()();
  RealColumn get lng => real()();
}
