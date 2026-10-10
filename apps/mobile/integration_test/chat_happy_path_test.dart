import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/features/chat/chat_happy_path.dart';

/// On an emulator or phone: `flutter test integration_test/chat_happy_path_test.dart`
/// (the API, the socket and FCM are faked, so no server or Firebase project
/// is needed). The same scenario runs headless in CI as
/// test/features/chat/chat_happy_path_test.dart.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'buyer messages from a post, seller replies, a push opens the conversation',
    runChatHappyPath,
  );
}
