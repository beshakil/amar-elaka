import 'package:flutter_test/flutter_test.dart';

import 'store_happy_path.dart';

void main() {
  testWidgets(
    'open a store, add three products, see them on its page',
    runStoreHappyPath,
  );
}
