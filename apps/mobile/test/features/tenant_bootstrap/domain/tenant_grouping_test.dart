import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/domain/tenant_grouping.dart';
import 'package:flutter_test/flutter_test.dart';

TenantSummary _tenant({
  required String id,
  required String nameBn,
  String? districtNameBn,
  String? districtNameEn,
}) {
  return TenantSummary(
    id: id,
    slug: id,
    nameBn: nameBn,
    nameEn: nameBn,
    mapCenter: const LatLng(lat: 0, lng: 0),
    districtNameBn: districtNameBn,
    districtNameEn: districtNameEn,
  );
}

void main() {
  group('groupByDistrict', () {
    test('groups tenants under their district and sorts both levels', () {
      final tenants = [
        _tenant(id: 'b', nameBn: 'বনানী', districtNameBn: 'ঢাকা'),
        _tenant(id: 'a', nameBn: 'আদাবর', districtNameBn: 'ঢাকা'),
        _tenant(id: 'c', nameBn: 'চকবাজার', districtNameBn: 'চট্টগ্রাম'),
      ];

      final groups = groupByDistrict(tenants);

      expect(groups.map((g) => g.districtName), ['চট্টগ্রাম', 'ঢাকা']);
      expect(
        groups
            .firstWhere((g) => g.districtName == 'ঢাকা')
            .tenants
            .map((t) => t.id),
        ['a', 'b'],
      );
    });

    test('falls back to the English district name when Bengali is missing', () {
      final tenants = [
        _tenant(
          id: 'a',
          nameBn: 'X',
          districtNameBn: null,
          districtNameEn: 'Dhaka',
        ),
      ];
      expect(groupByDistrict(tenants).single.districtName, 'Dhaka');
    });

    test('groups tenants with no district at all under the fallback label', () {
      final tenants = [_tenant(id: 'a', nameBn: 'X')];
      final groups = groupByDistrict(tenants, noDistrictLabel: 'Other');
      expect(groups.single.districtName, 'Other');
    });

    test('returns an empty list for an empty input', () {
      expect(groupByDistrict(const []), isEmpty);
    });
  });
}
