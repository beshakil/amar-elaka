import 'package:amar_elaka_app/core/dynamic_form/field_validator.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures.dart';

/// Parity with the server: test/fixtures/validation-cases.json holds payloads
/// and the issues the API's own validator reported for each. The app must
/// agree on every one.
void main() {
  final schemas = {
    'to-let': fixtureSchema('to-let'),
    'rent-a-car': fixtureSchema('rent-a-car'),
  };
  final cases = readFixture('validation-cases.json')['cases'] as List;

  List<String> sorted(Iterable<FieldIssue> issues) =>
      issues.map((i) => i.toString()).toList()..sort();

  test('has server verdicts to compare against', () {
    expect(cases.length, greaterThan(10));
  });

  for (final raw in cases.cast<Map<String, dynamic>>()) {
    test('${raw['category']}: ${raw['name']}', () {
      final expected = [
        for (final issue in raw['issues'] as List)
          FieldIssue.fromJson(issue as Map<String, dynamic>),
      ];
      final actual = validateFieldValues(
        schemas[raw['category']]!,
        raw['values'],
        fixtureContext,
      );
      expect(sorted(actual), sorted(expected));
    });
  }
}
