import 'package:amar_elaka_api/amar_elaka_api.dart';

/// One district heading with its thanas, sorted by name — the shape the
/// picker renders directly.
class TenantDistrictGroup {
  const TenantDistrictGroup({
    required this.districtName,
    required this.tenants,
  });

  final String districtName;
  final List<TenantSummary> tenants;
}

/// Groups tenants by district (falling back to a district-less group for
/// any tenant whose geo area has no district ancestor on record), sorted by
/// district name — [districtName] picks [TenantSummary.districtNameBn], the
/// app's default locale, falling back to the English name.
///
/// A pure function — no widget needed to unit test the grouping/sort order.
List<TenantDistrictGroup> groupByDistrict(
  List<TenantSummary> tenants, {
  String noDistrictLabel = '',
}) {
  final byDistrict = <String, List<TenantSummary>>{};
  for (final tenant in tenants) {
    final name =
        tenant.districtNameBn ?? tenant.districtNameEn ?? noDistrictLabel;
    byDistrict.putIfAbsent(name, () => []).add(tenant);
  }

  final groups = byDistrict.entries
      .map(
        (entry) => TenantDistrictGroup(
          districtName: entry.key,
          tenants: [...entry.value]
            ..sort((a, b) => a.nameBn.compareTo(b.nameBn)),
        ),
      )
      .toList();
  groups.sort((a, b) => a.districtName.compareTo(b.districtName));
  return groups;
}
