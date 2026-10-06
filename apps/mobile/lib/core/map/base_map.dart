import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../l10n/app_localizations.dart';
import '../design/tokens/app_spacing.dart';
import 'map_config_provider.dart';
import 'map_style.dart';

/// The native map on or off. Off in widget tests (no platform view there):
/// screens keep their pin, lookups and search, over a plain surface.
final baseMapEnabledProvider = Provider<bool>((ref) => true);

/// The Amar Elaka base map (ADR 043): MapLibre Native over our own Bangladesh
/// `.pmtiles` archive (`GET /map/config`), styled from assets/map, light or
/// dark with the app's theme. Bengali map text is shaped from Noto Sans
/// Bengali font files (`font-faces`). Never Barikoi tiles; never
/// tile.openstreetmap.org.
///
/// The OpenStreetMap / Protomaps credit is always visible as text (the native
/// attribution button alone hides it behind an (i)).
class BaseMap extends ConsumerStatefulWidget {
  const BaseMap({
    required this.initialCenter,
    required this.initialZoom,
    this.onMapCreated,
    this.onStyleLoaded,
    this.onCameraIdle,
    this.labelLanguage,
    this.dark,
    super.key,
  });

  final LatLng initialCenter;
  final double initialZoom;
  final void Function(MapLibreMapController controller)? onMapCreated;

  /// After every style load (a style change drops added sources and layers).
  final void Function(MapLibreMapController controller)? onStyleLoaded;

  /// The camera came to rest (after a gesture or an animation).
  final void Function(CameraPosition? position)? onCameraIdle;

  /// Overrides the `map_label_language` setting (the shaping debug screen).
  final String? labelLanguage;

  /// Overrides the app theme's brightness.
  final bool? dark;

  @override
  ConsumerState<BaseMap> createState() => _BaseMapState();
}

class _BaseMapState extends ConsumerState<BaseMap> {
  MapLibreMapController? _controller;
  Future<String?>? _style;
  Object? _styleKey;

  /// The style for these inputs, loaded once per distinct (config, theme, language).
  Future<String?> _styleFor(api.MapConfig config, bool dark, String lang) {
    final key = (config.tiles?.url, config.fallbackStyleUrl, dark, lang);
    if (key != _styleKey) {
      _styleKey = key;
      final tiles = config.tiles;
      _style = tiles != null
          ? MapStyles.load(
              DefaultAssetBundle.of(context),
              dark: dark,
              tilesUrl: tiles.url,
              assetsBaseUrl: config.assetsBaseUrl,
              labelLanguage: lang,
            )
          // map_style_fallback: emergencies only — a Barikoi style costs 4
          // Barikoi calls per map load.
          : Future.value(config.fallbackStyleUrl);
    }
    return _style!;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final placeholder = ColoredBox(
      color: theme.colorScheme.surfaceContainerHighest,
      child: const SizedBox.expand(),
    );
    if (!ref.watch(baseMapEnabledProvider)) {
      return KeyedSubtree(
        key: const ValueKey('base-map-off'),
        child: placeholder,
      );
    }
    final config = ref.watch(mapConfigProvider);
    return switch (config) {
      AsyncData(:final value) => FutureBuilder<String?>(
        future: _styleFor(
          value,
          widget.dark ?? theme.brightness == Brightness.dark,
          widget.labelLanguage ?? value.labelLanguage,
        ),
        builder: (context, snapshot) => switch (snapshot) {
          AsyncSnapshot(hasData: true, :final data?) => _map(data),
          AsyncSnapshot(connectionState: ConnectionState.done) =>
            const _Unavailable(),
          _ => placeholder,
        },
      ),
      AsyncError() => const _Unavailable(),
      _ => placeholder,
    };
  }

  Widget _map(String style) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Stack(
      children: [
        MapLibreMap(
          styleString: style,
          initialCameraPosition: CameraPosition(
            target: widget.initialCenter,
            zoom: widget.initialZoom,
          ),
          trackCameraPosition: true,
          rotateGesturesEnabled: false,
          tiltGesturesEnabled: false,
          compassEnabled: false,
          logoEnabled: false,
          attributionButtonPosition: AttributionButtonPosition.bottomRight,
          onMapCreated: (controller) {
            _controller = controller;
            widget.onMapCreated?.call(controller);
          },
          onStyleLoadedCallback: () {
            final controller = _controller;
            if (controller != null) widget.onStyleLoaded?.call(controller);
          },
          onCameraIdle: () =>
              widget.onCameraIdle?.call(_controller?.cameraPosition),
        ),
        Positioned(
          left: AppSpacing.xs,
          bottom: AppSpacing.xs,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: theme.colorScheme.surface.withValues(alpha: 0.8),
                borderRadius: BorderRadius.circular(AppSpacing.xs),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.xs,
                  vertical: AppSpacing.xxs,
                ),
                child: Text(
                  l10n.mapAttribution,
                  key: const ValueKey('map-attribution'),
                  style: theme.textTheme.labelSmall,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Unavailable extends StatelessWidget {
  const _Unavailable();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ColoredBox(
      key: const ValueKey('base-map-unavailable'),
      color: theme.colorScheme.surfaceContainerHighest,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Text(
            AppLocalizations.of(context)!.mapUnavailable,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
        ),
      ),
    );
  }
}
