import 'package:flutter_test/flutter_test.dart';

import 'feed_happy_path.dart';

void main() {
  testWidgets(
    'feed -> filter -> detail -> save -> call (the device test, headless)',
    runFeedHappyPath,
  );
}
