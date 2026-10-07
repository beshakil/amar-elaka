import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../l10n/app_localizations.dart';
import '../../features/offline_map/application/offline_map_source.dart';
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
/// With the area downloaded (ADR 050) the style reads the archive, fonts and
/// sprites from the phone instead: always when the user prefers it or there's
/// no connection, and whenever `/map/config` fails.
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
    this.onCameraMove,
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

  /// Every frame while the camera moves (keep it cheap: no rebuilds).
  final void Function(CameraPosition position)? onCameraMove;

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

  /// The style for these inputs, loaded once per distinct (source, theme, language).
  Future<String?> _styleFor({
    required String? tilesUrl,
    required String assetsBaseUrl,
    required bool dark,
    required String lang,
  }) {
    final key = (tilesUrl, assetsBaseUrl, dark, lang);
    if (key != _styleKey) {
      _styleKey = key;
      _style = tilesUrl != null
          ? MapStyles.load(
              DefaultAssetBundle.of(context),
              dark: dark,
              tilesUrl: tilesUrl,
              assetsBaseUrl: assetsBaseUrl,
              labelLanguage: lang,
            )
          // No tiles on the server: the map says it is unavailable, never a
          // third-party style (CLAUDE.md map rules).
          : Future.value(null);
    }
    return _style!;
  }

  Widget _styled(Future<String?> style, Widget placeholder) =>
      FutureBuilder<String?>(
        future: style,
        builder: (context, snapshot) => switch (snapshot) {
          AsyncSnapshot(hasData: true, :final data?) => _map(data),
          AsyncSnapshot(connectionState: ConnectionState.done) =>
            const _Unavailable(),
          _ => placeholder,
        },
      );

  Widget _local(LocalMapSource source, bool dark, Widget placeholder) =>
      _styled(
        _styleFor(
          tilesUrl: source.tilesUrl,
          assetsBaseUrl: source.assetsBaseUrl,
          dark: dark,
          lang: widget.labelLanguage ?? source.labelLanguage,
        ),
        placeholder,
      );

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
    final dark = widget.dark ?? theme.brightness == Brightness.dark;
    final local = ref.watch(localMapSourceProvider);
    if (local != null) return _local(local, dark, placeholder);
    final config = ref.watch(mapConfigProvider);
    return switch (config) {
      AsyncData(:final value) => _styled(
        _styleFor(
          tilesUrl: value.tiles?.url,
          assetsBaseUrl: value.assetsBaseUrl,
          dark: dark,
          lang: widget.labelLanguage ?? value.labelLanguage,
        ),
        placeholder,
      ),
      AsyncError() => switch (ref.watch(installedLocalMapSourceProvider)) {
        final installed? => _local(installed, dark, placeholder),
        null => const _Unavailable(),
      },
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
          onCameraMove: widget.onCameraMove,
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
