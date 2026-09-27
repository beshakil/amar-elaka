import 'package:flutter_driver/flutter_driver.dart' as driver;
import 'package:integration_test/integration_test_driver.dart';

/// Writes the feed-scroll frame timings (ADR 038) to
/// build/feed_scroll.timeline_summary.json: build and raster times
/// (average, p90, p99, worst) and missed frames. Run on the phone:
///
///   flutter drive --profile \
///     --driver=test_driver/perf_driver.dart \
///     --target=integration_test/feed_scroll_perf_test.dart
Future<void> main() => integrationDriver(
  responseDataCallback: (data) async {
    final trace = data?['feed_scroll'];
    if (trace == null) return;
    final summary = driver.TimelineSummary.summarize(
      driver.Timeline.fromJson(trace as Map<String, dynamic>),
    );
    await summary.writeTimelineToFile(
      'feed_scroll',
      pretty: true,
      includeSummary: true,
    );
  },
);
