import 'package:amar_elaka_app/features/offline_map/application/offline_map_controller.dart';
import 'package:amar_elaka_app/features/offline_map/presentation/offline_map_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'offline_map_test_support.dart';

/// The screen's states, driven by a scripted controller (the controller
/// itself is tested over a real download in offline_map_controller_test).
class ScriptedController extends OfflineMapController {
  ScriptedController(this.initial);

  final OfflineMapState initial;
  final calls = <String>[];

  @override
  OfflineMapState build() => initial;

  @override
  Future<void> check() async => calls.add('check');

  @override
  Future<void> download() async {
    calls.add('download');
    state = state.copyWith(
      phase: OfflineMapPhase.downloading,
      done: 1024 * 1024,
      total: 2 * 1024 * 1024,
    );
  }

  @override
  void cancel() => calls.add('cancel');

  @override
  Future<void> delete() async {
    calls.add('delete');
    state = OfflineMapState(manifest: state.manifest);
  }
}

Future<ScriptedController> pumpScreen(
  WidgetTester tester,
  OfflineMapState initial,
) async {
  SharedPreferences.setMockInitialValues({});
  final controller = ScriptedController(initial);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [offlineMapControllerProvider.overrideWith(() => controller)],
      child: MaterialApp(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: const OfflineMapScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return controller;
}

void main() {
  late TestFileServer server;

  setUpAll(() async {
    server = await TestFileServer.start({
      'tenants/mirpur-20261001.pmtiles': bytesOf(1887437),
      'tenants/mirpur-20261101.pmtiles': bytesOf(2097152),
    });
  });
  tearDownAll(() => server.close());

  testWidgets('the size before anything downloads; then progress', (
    tester,
  ) async {
    final c = await pumpScreen(
      tester,
      OfflineMapState(manifest: manifestFor(server)),
    );
    expect(c.calls, ['check']);
    // 1887437 bytes = 1.8 MB, in Bengali digits.
    expect(find.text('ডাউনলোড করুন (১.৮ MB)'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('offline-map-download')));
    await tester.pump();
    expect(find.byKey(const ValueKey('offline-map-progress')), findsOneWidget);
    expect(find.text('১.০ / ২.০ MB'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('offline-map-cancel')));
    expect(c.calls.last, 'cancel');
  });

  testWidgets(
    'installed and a newer version: the notice and the update button',
    (tester) async {
      await pumpScreen(
        tester,
        OfflineMapState(
          installed: installedRow(),
          manifest: manifestFor(server, version: '20261101'),
        ),
      );
      expect(
        find.byKey(const ValueKey('offline-map-installed')),
        findsOneWidget,
      );
      expect(find.text('ম্যাপের নতুন সংস্করণ এসেছে (২.০ MB)'), findsOneWidget);
      expect(find.text('নতুন সংস্করণ নিন (২.০ MB)'), findsOneWidget);
    },
  );

  testWidgets('delete asks first', (tester) async {
    final c = await pumpScreen(
      tester,
      OfflineMapState(installed: installedRow(), manifest: manifestFor(server)),
    );
    // Up to date: no download button.
    expect(find.byKey(const ValueKey('offline-map-download')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('offline-map-delete')));
    await tester.pumpAndSettle();
    expect(find.text('ডাউনলোড করা ম্যাপ মুছবেন?'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('offline-map-delete-confirm')));
    await tester.pumpAndSettle();
    expect(c.calls.last, 'delete');
    expect(find.byKey(const ValueKey('offline-map-installed')), findsNothing);
    expect(find.text('ডাউনলোড করুন (১.৮ MB)'), findsOneWidget);
  });

  testWidgets('errors are worded; the switches start on', (tester) async {
    await pumpScreen(
      tester,
      const OfflineMapState(
        phase: OfflineMapPhase.failed,
        error: OfflineMapError.checksum,
      ),
    );
    expect(
      find.text('ফাইলটি ঠিকমতো নামেনি — আবার ডাউনলোড করুন'),
      findsOneWidget,
    );
    final switches = tester.widgetList<SwitchListTile>(
      find.byType(SwitchListTile),
    );
    expect(switches.map((s) => s.value), [true, true]);
  });
}
