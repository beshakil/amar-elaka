import 'package:flutter_test/flutter_test.dart';

import 'post_happy_path.dart';

void main() {
  testWidgets(
    'create a post from start to finish (the device test, headless)',
    runPostHappyPath,
  );
}
