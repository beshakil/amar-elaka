import 'package:amar_elaka_app/core/dynamic_form/filters.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures.dart';

void main() {
  final toLet = fixtureSchema('to-let');
  final rentACar = fixtureSchema('rent-a-car');

  test('turns "bedrooms ≥ 2 and rent ≤ ১৫,০০০" into the API filter format', () {
    final result = toRawFilters(toLet, {
      'bedrooms': const RangeState(min: '২'),
      'price': const RangeState(max: '১৫,০০০'),
      'property_type': ['flat', 'house'],
      'has_lift': true,
      'water_24h': false,
    });
    expect(result.filters, const [
      RawFieldFilter('property_type', 'in', 'flat,house'),
      RawFieldFilter('bedrooms', 'gte', '2'),
      RawFieldFilter('price', 'lte', '15000.00'),
      RawFieldFilter('has_lift', 'eq', 'true'),
    ]);
    expect(result.issues, isEmpty);
    expect(
      filtersToQuery(result.filters),
      'f.property_type.in=flat%2Chouse&f.bedrooms.gte=2&f.price.lte=15000.00&f.has_lift.eq=true',
    );
  });

  test('uses eq for one select option and any for multiselects', () {
    expect(
      toRawFilters(rentACar, {
        'vehicle_type': ['suv'],
        'trip_types': ['airport'],
      }).filters,
      const [
        RawFieldFilter('vehicle_type', 'eq', 'suv'),
        RawFieldFilter('trip_types', 'any', 'airport'),
      ],
    );
  });

  test('reports invalid bounds and min above max', () {
    expect(
      toRawFilters(toLet, {
        'bedrooms': const RangeState(min: '৫', max: '২'),
        'floor': const RangeState(min: 'abc'),
      }).issues,
      const [
        FilterIssue('bedrooms', 'min', FilterIssueKind.minAboveMax),
        FilterIssue('floor', 'min', FilterIssueKind.invalidInteger),
      ],
    );
  });
}
