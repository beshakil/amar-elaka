import 'dart:convert';
import 'dart:io';

import 'package:amar_elaka_app/core/dynamic_form/field_schema.dart';
import 'package:amar_elaka_app/core/dynamic_form/field_validator.dart';

/// Fixtures generated from the API's seed taxonomy by
/// `pnpm --filter @amar-elaka/api fixtures:export` (test/fixtures/).
Map<String, dynamic> readFixture(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

CategoryFieldSchema fixtureSchema(String slug) =>
    CategorySchemaEntry.fromJson(readFixture('$slug.json')).schema;

const fixtureContext = ValidationContext(
  today: '2026-09-24',
  currentYear: 2026,
);
