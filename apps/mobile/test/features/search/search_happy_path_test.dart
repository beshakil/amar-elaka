import 'package:flutter_test/flutter_test.dart';

import 'search_happy_path.dart';

/// The search happy path, headless (the same scenario runs on a device as
/// integration_test/search_happy_path_test.dart).
void main() {
  testWidgets('Banglish search -> filter -> save search', runSearchHappyPath);
}
