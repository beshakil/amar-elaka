import 'package:flutter_test/flutter_test.dart';

import 'chat_happy_path.dart';

void main() {
  testWidgets(
    'buyer messages from a post, seller replies, a push opens the conversation',
    runChatHappyPath,
  );
}
