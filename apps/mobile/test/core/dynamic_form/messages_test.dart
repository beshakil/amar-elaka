import 'package:amar_elaka_app/core/dynamic_form/field_messages.dart';
import 'package:amar_elaka_app/core/dynamic_form/field_validator.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures.dart';

void main() {
  final bn = lookupAppLocalizations(const Locale('bn'));
  final toLet = fixtureSchema('to-let');
  final rentACar = fixtureSchema('rent-a-car');

  test('every issue the server can report has a Bengali message', () {
    final cases = readFixture('validation-cases.json')['cases'] as List;
    for (final raw in cases.cast<Map<String, dynamic>>()) {
      final schema = raw['category'] == 'to-let' ? toLet : rentACar;
      for (final issue in raw['issues'] as List) {
        final message = describeIssue(
          bn,
          schema,
          FieldIssue.fromJson(issue as Map<String, dynamic>),
          'bn',
          fixtureContext,
        );
        expect(message, isNotEmpty);
        expect(message, isNot(contains('field.')));
      }
    }
  });

  test('fills ranges with Bengali digits and grouped money', () {
    String msg(String field, String code, [String? schemaSlug]) =>
        describeIssue(
          bn,
          schemaSlug == 'rent-a-car' ? rentACar : toLet,
          FieldIssue(field, code),
          'bn',
          fixtureContext,
        );
    expect(
      msg('bedrooms', FieldIssueCodes.outOfRange),
      '০ থেকে ২০-এর মধ্যে হতে হবে।',
    );
    expect(
      msg('price', FieldIssueCodes.outOfRange),
      '৳১০০ থেকে ৳১,০০,০০,০০০-এর মধ্যে হতে হবে।',
    );
    expect(
      msg('model_year', FieldIssueCodes.outOfRange, 'rent-a-car'),
      '১৯৭০ থেকে ২০২৭-এর মধ্যে হতে হবে।',
    );
    expect(
      msg('total_floors', FieldIssueCodes.lessThanField),
      'তলা-এর চেয়ে কম হতে পারবে না।',
    );
  });
}
