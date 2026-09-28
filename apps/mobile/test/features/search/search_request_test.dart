import 'package:amar_elaka_app/features/search/domain/search_request.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SearchRequest', () {
    test(
      'becomes GET /search parameters: area by default, nearby with a radius',
      () {
        expect(const SearchRequest(q: '  basa vara ').queryParameters(), {
          'type': 'posts',
          'q': 'basa vara',
          'scope': 'area',
          'sort': 'relevance',
        });
        final narrowed = const SearchRequest(q: 'flat')
            .withCategory('to-let')
            .toggleFieldValue('condition', 'used')
            .toggleFieldValue('condition', 'new')
            .withPrice('10000.00', '20000.00')
            .withSort(SearchSort.priceAsc)
            .withRadius(20);
        expect(narrowed.queryParameters(lat: 23.8, lng: 90.4, cursor: 'c2'), {
          'type': 'posts',
          'q': 'flat',
          'scope': 'nearby',
          'radius_km': 20.0,
          'category': 'to-let',
          'filters': '{"condition":{"in":["used","new"]}}',
          'price_min': '10000.00',
          'price_max': '20000.00',
          'sort': 'price_asc',
          'lat': 23.8,
          'lng': 90.4,
          'cursor': 'c2',
        });
      },
    );

    test('a single true/false value is an equality filter', () {
      final r = const SearchRequest()
          .withCategory('to-let')
          .toggleFieldValue('has_lift', 'true');
      expect(r.fieldFilters, {
        'has_lift': {'eq': true},
      });
    });

    test('lists active filters and removes them one by one', () {
      final r = const SearchRequest(q: 'x')
          .withCategory('to-let')
          .toggleFieldValue('condition', 'used')
          .withPrice(null, '5000.00');
      expect(r.activeFilters.map((f) => f.runtimeType), [
        CategoryFilter,
        PriceFilter,
        FieldFilter,
      ]);
      final withoutPrice = r.without(r.activeFilters[1]);
      expect(withoutPrice.priceMax, isNull);
      expect(withoutPrice.fieldValues, {
        'condition': ['used'],
      });
      // Dropping the category drops its field values too.
      expect(
        r
            .without(r.activeFilters.first)
            .activeFilters
            .map((f) => f.runtimeType),
        [PriceFilter],
      );
      expect(r.clearFilters().hasFilters, isFalse);
      expect(r.clearFilters().q, 'x');
    });

    test(
      'toggling a value off removes the field; a new category resets fields',
      () {
        final r = const SearchRequest()
            .withCategory('to-let')
            .toggleFieldValue('condition', 'used');
        expect(r.toggleFieldValue('condition', 'used').fieldValues, isEmpty);
        expect(r.withCategory('mobile-phones').fieldValues, isEmpty);
      },
    );

    test('saves with the same meaning (ADR 041)', () {
      final r = const SearchRequest(q: 'flat')
          .withCategory('to-let')
          .toggleFieldValue('condition', 'used')
          .withPrice('10000.00', null);
      expect(r.toSavedFilters().toRequestJson(), {
        'category': 'to-let',
        'fields': {
          'condition': {
            'in': ['used'],
          },
        },
        'price_min': '10000.00',
      });
    });

    test('equal when the search is the same', () {
      expect(const SearchRequest(q: ' a '), const SearchRequest(q: 'a'));
      expect(
        const SearchRequest(q: 'a') == const SearchRequest(q: 'b'),
        isFalse,
      );
    });
  });
}
