import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/features/feed/feed_happy_path.dart';

/// On an emulator or phone: `flutter test integration_test/feed_happy_path_test.dart`
/// (the API is faked, so no server is needed). The same scenario runs
/// headless in CI as test/features/feed/feed_happy_path_test.dart.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('feed -> filter -> detail -> save -> call', runFeedHappyPath);
}
