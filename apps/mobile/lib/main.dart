import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/design/global_error_fallback.dart';

void main() {
  // A widget failing to build shows GlobalErrorFallback, never Flutter's
  // default red error box or a blank screen.
  ErrorWidget.builder = (details) => const GlobalErrorFallback();

  // Anything that escapes a widget's build (async errors, errors outside a
  // build method) is logged instead of crashing the app outright or being
  // silently swallowed.
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    if (kDebugMode) debugPrint('FlutterError: ${details.exceptionAsString()}');
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    if (kDebugMode) debugPrint('Uncaught error: $error\n$stack');
    return true;
  };

  runApp(const ProviderScope(child: App()));
}
