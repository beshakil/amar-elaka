import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/features/store/store_happy_path.dart';

/// On an emulator or phone: `flutter test integration_test/store_happy_path_test.dart`
/// (the API is faked, so no server is needed). The same scenario runs headless
/// in CI as test/features/store/store_happy_path_test.dart.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'open a store, add three products, see them on its page',
    runStoreHappyPath,
  );
}
