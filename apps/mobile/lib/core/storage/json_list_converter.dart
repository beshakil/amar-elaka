import 'dart:convert';

import 'package:drift/drift.dart';

/// `List<String>` stored as JSON text — shared by any Drift column that
/// needs a small string list (e.g. `EmergencyContactCache.phones`).
class StringListConverter extends TypeConverter<List<String>, String> {
  const StringListConverter();

  @override
  List<String> fromSql(String fromDb) =>
      (jsonDecode(fromDb) as List<dynamic>).cast<String>();

  @override
  String toSql(List<String> value) => jsonEncode(value);
}
