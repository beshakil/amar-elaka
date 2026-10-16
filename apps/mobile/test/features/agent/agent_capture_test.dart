import 'dart:async';

import 'package:amar_elaka_app/features/agent/application/agent_providers.dart';
import 'package:amar_elaka_app/features/agent/data/agent_bootstrap.dart';
import 'package:amar_elaka_app/features/agent/data/agent_models.dart';
import 'package:amar_elaka_app/features/agent/data/gps_source.dart';
import 'package:amar_elaka_app/features/agent/presentation/agent_capture_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// The capture form (ADR 066): it will not save on a GPS fix worse than
/// agent_min_gps_accuracy_m — the agent sees the accuracy and waits.

class FakeGps implements GpsSource {
  final controller = StreamController<GpsFix>.broadcast();

  @override
  Future<bool> ensureAllowed() async => true;

  @override
  Stream<GpsFix> fixes() => controller.stream;

  void emit(double accuracyM) => controller.add(
    GpsFix(
      lat: 23.8,
      lng: 90.4,
      accuracyM: accuracyM,
      at: DateTime(2026, 10, 16),
    ),
  );
}

const _me = AgentMe(
  id: 'agent-1',
  code: 'MIR-01',
  status: 'active',
  targets: AgentTargets(dailyShops: 15),
  minGpsAccuracyM: 25,
  photosMax: 3,
  captureMaxAgeDays: 14,
);

void main() {
  testWidgets('refuses to save until the GPS fix is accurate enough', (
    tester,
  ) async {
    final gps = FakeGps();
    addTearDown(gps.controller.close);
    // A tall phone: the whole form (and its save button) is built.
    tester.view.physicalSize = const Size(1080, 4000);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          gpsSourceProvider.overrideWithValue(gps),
          agentBootstrapProvider.overrideWith(
            (ref) async =>
                const AgentBootstrap(me: _me, categories: [], fromCache: false),
          ),
        ],
        child: const MaterialApp(
          locale: Locale('bn'),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          // A verification needs no new-shop fields: only the fix decides here.
          home: AgentCaptureScreen(
            task: AgentTask(
              id: 'task-1',
              type: 'verify_shop',
              title: 'দোকানটি খোলা কি না দেখুন',
              status: 'open',
              dueOn: '2026-10-16',
              placeId: 'place-1',
              placeName: 'করিম স্টোর',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    FilledButton save() =>
        tester.widget<FilledButton>(find.byKey(const ValueKey('capture-save')));

    // No fix yet.
    expect(save().onPressed, isNull);
    expect(find.text('GPS খুঁজছে…'), findsOneWidget);

    // ±60 m: shown, and refused.
    gps.emit(60);
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('±৬০ মি'), findsOneWidget);
    expect(find.textContaining('±২৫ মি বা কম'), findsOneWidget);
    expect(save().onPressed, isNull);

    // ±8 m: good enough.
    gps.emit(8);
    await tester.pump();
    await tester.pump();
    expect(save().onPressed, isNotNull);
  });
}
