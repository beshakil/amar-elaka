import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/map/base_map.dart';
import '../../../core/map/map_config_provider.dart';
import '../../../l10n/app_localizations.dart';

/// The names to check: conjuncts (ক্র, ন্ড, ট্ট, ব্র + হ্ম, ক্স), vowel signs
/// before and after the consonant (ি, ে, ো, া) and Bengali digits — real places
/// at their real coordinates. Mirrors SHAPING_SAMPLES on the web's /dev/map.
const _samples = [
  ('ক্রিসেন্ট লেক', 23.7629, 90.3787),
  ('শ্যামলী', 23.7746, 90.3655),
  ('ধানমন্ডি ২৭', 23.7556, 90.3747),
  ('চট্টগ্রাম', 22.3569, 91.7832),
  ('ব্রাহ্মণবাড়িয়া', 23.9571, 91.1119),
  ('কক্সবাজার', 21.4272, 92.0058),
];

const _source = 'shaping-samples';
final _allBounds = LatLngBounds(
  southwest: const LatLng(21.2, 90.2),
  northeast: const LatLng(24.1, 92.2),
);
const _dhaka = LatLng(23.764, 90.374);
const _dhakaZoom = 13.5;

/// Debug builds only: the Bengali shaping spike (ADR 043). The six names as
/// MapLibre map text — shaped from Noto Sans Bengali through the style's
/// `font-faces` — beside the same names as Flutter text. Check on a real
/// Android phone: if conjuncts break on the map, `map_label_language` stays
/// `en` and Bengali names are shown only in Flutter UI (sheets, cards).
class MapDebugScreen extends ConsumerStatefulWidget {
  const MapDebugScreen({super.key});

  @override
  ConsumerState<MapDebugScreen> createState() => _MapDebugScreenState();
}

class _MapDebugScreenState extends ConsumerState<MapDebugScreen> {
  MapLibreMapController? _map;
  bool _dark = false;
  bool _bengali = true;

  Future<void> _addSamples(MapLibreMapController map) async {
    await map.addGeoJsonSource(_source, {
      'type': 'FeatureCollection',
      'features': [
        for (final (name, lat, lng) in _samples)
          {
            'type': 'Feature',
            'properties': {'label': name},
            'geometry': {
              'type': 'Point',
              'coordinates': [lng, lat],
            },
          },
      ],
    });
    await map.addCircleLayer(
      _source,
      '$_source-dots',
      const CircleLayerProperties(
        circleRadius: 5,
        circleColor: '#d6336c',
        circleStrokeWidth: 2,
        circleStrokeColor: '#ffffff',
      ),
    );
    await map.addSymbolLayer(
      _source,
      '$_source-labels',
      const SymbolLayerProperties(
        textField: [Expressions.get, 'label'],
        textFont: ['Noto Sans Regular'],
        textSize: 22,
        textAnchor: 'top',
        textOffset: [0, 0.6],
        textAllowOverlap: true,
        textIgnorePlacement: true,
        textColor: '#111111',
        textHaloColor: '#ffffff',
        textHaloWidth: 2,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final setting = ref.watch(mapConfigProvider).value?.labelLanguage ?? '—';

    return Scaffold(
      appBar: AppBar(title: Text(l10n.mapDebugTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(l10n.mapDebugIntro, style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          Text(l10n.mapDebugSetting(setting), style: theme.textTheme.bodySmall),
          SwitchListTile(
            title: Text(l10n.mapDebugDark),
            value: _dark,
            onChanged: (v) => setState(() => _dark = v),
          ),
          SwitchListTile(
            title: Text(l10n.mapDebugBengaliLabels),
            value: _bengali,
            onChanged: (v) => setState(() => _bengali = v),
          ),
          Wrap(
            spacing: AppSpacing.sm,
            children: [
              OutlinedButton(
                onPressed: () => unawaited(
                  _map?.animateCamera(
                    CameraUpdate.newLatLngBounds(
                      _allBounds,
                      left: AppSpacing.xl,
                      top: AppSpacing.xl,
                      right: AppSpacing.xl,
                      bottom: AppSpacing.xl,
                    ),
                  ),
                ),
                child: Text(l10n.mapDebugFitAll),
              ),
              OutlinedButton(
                onPressed: () => unawaited(
                  _map?.animateCamera(
                    CameraUpdate.newLatLngZoom(_dhaka, _dhakaZoom),
                  ),
                ),
                child: Text(l10n.mapDebugDhaka),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          SizedBox(
            height: 420,
            child: BaseMap(
              initialCenter: const LatLng(22.65, 91.2),
              initialZoom: 6.5,
              dark: _dark,
              labelLanguage: _bengali ? 'bn' : 'en',
              onMapCreated: (map) => _map = map,
              onStyleLoaded: (map) => unawaited(_addSamples(map)),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(l10n.mapDebugReference, style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.xs),
          for (final (name, _, _) in _samples)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
              child: Text(name, style: theme.textTheme.headlineSmall),
            ),
        ],
      ),
    );
  }
}
