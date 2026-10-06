import 'dart:async';
import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/barikoi_attribution.dart';
import '../../../core/map/base_map.dart';
import '../../../core/map/map_config_provider.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/current_tenant.dart';
import '../../tenant_bootstrap/data/location_service.dart';

const _pointsSource = 'ae-points';
const _routeSource = 'ae-route';
const _clusterLayer = 'ae-clusters';
const _pointLayer = 'ae-point-dots';

const _initialZoom = 13.0;
// Web Mercator facts: 256 px tiles; 360 degrees of longitude per world width.
const _tilePx = 256.0;
const _degreesAround = 360.0;
const _metersPerKm = 1000;
const _secondsPerMinute = 60;

/// One colour per layer (presentation), readable on both map themes.
const _colourByLayer = [
  'match',
  ['get', 'layer'],
  'posts',
  '#d6336c',
  'stores',
  '#1c7ed6',
  'places',
  '#2f9e44',
  'landmarks',
  '#f59f00',
  '#e03131',
];
const _isLandmark = [
  '==',
  ['get', 'layer'],
  'landmarks',
];

const _emptyCollection = {'type': 'FeatureCollection', 'features': <Object>[]};

enum _RouteState { idle, loading, needsLocation, limited, failed }

/// The area map (ADR 044, 045): our base map with the API's GeoJSON
/// features (posts, stores, places, landmarks, info), clustered on the
/// server for the viewport, fetched when the camera comes to rest — never while it
/// moves. A cluster zooms in on a tap; a point opens its card; a route is
/// asked for only by the card's button, from the user's own location
/// (Barikoi, metered on the server). The list gives the same items without
/// the map.
class MapScreen extends ConsumerStatefulWidget {
  const MapScreen({super.key});

  @override
  ConsumerState<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends ConsumerState<MapScreen> {
  MapLibreMapController? _map;
  final Set<String> _shown = {...api.mapLayers};
  bool _openNow = false;
  api.MapFeatures? _points;
  bool _failed = false;
  int _request = 0;
  api.MapFeature? _selected;
  api.RouteAnswer? _route;
  _RouteState _routeState = _RouteState.idle;
  LatLngBox? _box;
  double _zoom = _initialZoom;

  @override
  void initState() {
    super.initState();
    // Before the map exists (or without it): the viewport around the area's
    // centre at the opening zoom, for this screen's size.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _box = _viewportAround(_center, _initialZoom, MediaQuery.sizeOf(context));
      unawaited(_load());
    });
  }

  LatLng get _center {
    final center = ref.read(currentTenantConfigProvider)?.mapCenter;
    // Bootstrapped apps always have a tenant; Dhaka only for a bare test/edge case.
    return center == null
        ? const LatLng(23.8103, 90.4125)
        : LatLng(center.lat, center.lng);
  }

  static LatLngBox _viewportAround(LatLng center, double zoom, Size size) {
    final degreesPerPx = _degreesAround / (_tilePx * math.pow(2, zoom));
    final halfLng = size.width / 2 * degreesPerPx;
    final halfLat =
        size.height /
        2 *
        degreesPerPx *
        math.cos(center.latitude * math.pi / 180);
    return (
      minLng: center.longitude - halfLng,
      minLat: center.latitude - halfLat,
      maxLng: center.longitude + halfLng,
      maxLat: center.latitude + halfLat,
    );
  }

  Future<void> _load() async {
    final box = _box;
    if (box == null) return;
    final id = ++_request;
    try {
      final points = await ref
          .read(mapApiProvider)
          .features(bbox: box, zoom: _zoom, layers: _shown, openNow: _openNow);
      if (!mounted || id != _request) return;
      setState(() {
        _points = points;
        _failed = false;
      });
      await _map?.setGeoJsonSource(_pointsSource, _collection(points.features));
    } on AppException {
      if (mounted && id == _request) setState(() => _failed = true);
    }
  }

  /// The API's GeoJSON as is, each feature's id its index so a tap finds
  /// the full feature again.
  static Map<String, dynamic> _collection(List<api.MapFeature> features) => {
    'type': 'FeatureCollection',
    'features': [
      for (final (index, feature) in features.indexed)
        {...feature.toJson(), 'id': index},
    ],
  };

  void _onMapCreated(MapLibreMapController controller) {
    _map = controller;
    controller.onFeatureTapped.add((
      point,
      coordinates,
      id,
      layerId,
      annotation,
    ) {
      if (layerId != _clusterLayer && layerId != _pointLayer) return;
      final index = int.tryParse(id);
      final items = _points?.features;
      if (index == null || items == null || index >= items.length) return;
      _activate(items[index]);
    });
  }

  /// Our layers over the base map; re-added after every style change (theme).
  Future<void> _onStyleLoaded(MapLibreMapController map) async {
    await map.addGeoJsonSource(_routeSource, _routeCollection(_route));
    await map.addLineLayer(
      _routeSource,
      'ae-route-line',
      const LineLayerProperties(
        lineColor: '#1c7ed6',
        lineWidth: 5,
        lineOpacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      ),
      enableInteraction: false,
    );
    await map.addGeoJsonSource(
      _pointsSource,
      _points == null ? _emptyCollection : _collection(_points!.features),
    );
    await map.addCircleLayer(
      _pointsSource,
      _clusterLayer,
      const CircleLayerProperties(
        circleColor: _colourByLayer,
        circleOpacity: 0.85,
        circleRadius: [
          'step',
          ['get', 'count'],
          14,
          10,
          18,
          50,
          24,
          200,
          30,
        ],
        circleStrokeWidth: 2,
        circleStrokeColor: '#ffffff',
      ),
      filter: [
        '==',
        ['get', 'cluster'],
        true,
      ],
    );
    await map.addSymbolLayer(
      _pointsSource,
      'ae-cluster-count',
      const SymbolLayerProperties(
        textField: [
          'to-string',
          ['get', 'count'],
        ],
        textFont: ['Noto Sans Medium'],
        textSize: 12,
        textAllowOverlap: true,
        textColor: '#ffffff',
      ),
      filter: [
        '==',
        ['get', 'cluster'],
        true,
      ],
      enableInteraction: false,
    );
    await map.addCircleLayer(
      _pointsSource,
      _pointLayer,
      const CircleLayerProperties(
        circleColor: _colourByLayer,
        circleRadius: ['case', _isLandmark, 9, 7],
        circleStrokeWidth: ['case', _isLandmark, 3, 2],
        circleStrokeColor: '#ffffff',
      ),
      filter: [
        '==',
        ['get', 'cluster'],
        false,
      ],
    );
  }

  Future<void> _onCameraIdle(CameraPosition? position) async {
    final map = _map;
    if (map == null || position == null) return;
    final region = await map.getVisibleRegion();
    _box = (
      minLng: region.southwest.longitude,
      minLat: region.southwest.latitude,
      maxLng: region.northeast.longitude,
      maxLat: region.northeast.latitude,
    );
    _zoom = position.zoom;
    await _load();
  }

  void _activate(api.MapFeature item) {
    if (item.isCluster) {
      unawaited(
        _map?.animateCamera(
          CameraUpdate.newLatLngZoom(
            LatLng(item.lat, item.lng),
            (item.properties.expansionZoom ?? _zoom + 1).toDouble(),
          ),
        ),
      );
      return;
    }
    setState(() {
      _selected = item;
      _route = null;
      _routeState = _RouteState.idle;
    });
    unawaited(_map?.setGeoJsonSource(_routeSource, _emptyCollection));
  }

  Future<void> _showRoute(String mode) async {
    final target = _selected;
    if (target == null) return;
    setState(() => _routeState = _RouteState.loading);
    final position = await ref
        .read(locationServiceProvider)
        .requestAndGetPosition();
    if (!mounted) return;
    if (position is! LocationGranted) {
      setState(() => _routeState = _RouteState.needsLocation);
      return;
    }
    try {
      final route = await ref
          .read(mapApiProvider)
          .route(
            fromLat: position.latitude,
            fromLng: position.longitude,
            toLat: target.lat,
            toLng: target.lng,
            mode: mode,
          );
      if (!mounted) return;
      setState(() {
        _route = route;
        _routeState = _RouteState.idle;
      });
      await _drawRoute(route);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(
        () => _routeState = e.statusCode == 429
            ? _RouteState.limited
            : _RouteState.failed,
      );
    } on AppException {
      if (mounted) setState(() => _routeState = _RouteState.failed);
    }
  }

  Future<void> _drawRoute(api.RouteAnswer route) async {
    final map = _map;
    final line = route.polyline;
    if (map == null) return;
    await map.setGeoJsonSource(_routeSource, _routeCollection(route));
    if (line == null || line.length < 2) return;
    final lngs = line.map((c) => c[0]);
    final lats = line.map((c) => c[1]);
    await map.animateCamera(
      CameraUpdate.newLatLngBounds(
        LatLngBounds(
          southwest: LatLng(lats.reduce(math.min), lngs.reduce(math.min)),
          northeast: LatLng(lats.reduce(math.max), lngs.reduce(math.max)),
        ),
        left: AppSpacing.xxl,
        top: AppSpacing.xxl,
        right: AppSpacing.xxl,
        bottom: AppSpacing.xxl,
      ),
    );
  }

  static Map<String, dynamic> _routeCollection(api.RouteAnswer? route) {
    final polyline = route?.polyline;
    if (polyline == null) return _emptyCollection;
    return {
      'type': 'FeatureCollection',
      'features': [
        {
          'type': 'Feature',
          'properties': <String, Object>{},
          'geometry': {'type': 'LineString', 'coordinates': polyline},
        },
      ],
    };
  }

  static String _layerLabel(AppLocalizations l10n, String layer) =>
      switch (layer) {
        'posts' => l10n.mapKindPosts,
        'stores' => l10n.mapKindStores,
        'places' => l10n.mapKindPlaces,
        'landmarks' => l10n.mapLayerLandmarks,
        _ => l10n.mapLayerInfo,
      };

  String _distance(AppLocalizations l10n, double meters, String locale) {
    if (meters >= _metersPerKm) {
      final km = (meters / _metersPerKm)
          .toStringAsFixed(1)
          .replaceFirst(RegExp(r'\.0$'), '');
      return l10n.mapKm(localizeDigits(km, locale));
    }
    return l10n.mapMeters(localizeDigits('${meters.round()}', locale));
  }

  void _openList(AppLocalizations l10n, String locale) {
    final items = _points?.features ?? const <api.MapFeature>[];
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheet) => items.isEmpty
            ? Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Text(l10n.mapEmpty),
              )
            : ListView(
                children: [
                  for (final item in items)
                    ListTile(
                      leading: Icon(
                        item.isCluster
                            ? Icons.bubble_chart_outlined
                            : Icons.place_outlined,
                      ),
                      title: Text(
                        item.isCluster
                            ? l10n.mapClusterItem(
                                localizeDigits(
                                  '${item.properties.count}',
                                  locale,
                                ),
                                _layerLabel(l10n, item.properties.layer),
                              )
                            : (item.properties.nameBn ??
                                  item.properties.nameEn ??
                                  l10n.mapUnnamed),
                      ),
                      onTap: () {
                        Navigator.of(sheet).pop();
                        _activate(item);
                      },
                    ),
                ],
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final points = _points;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.sm,
            AppSpacing.md,
            0,
          ),
          child: Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: AppSpacing.xs,
                  children: [
                    for (final layer in api.mapLayers)
                      FilterChip(
                        key: ValueKey('map-layer-$layer'),
                        label: Text(_layerLabel(l10n, layer)),
                        selected: _shown.contains(layer),
                        onSelected: (on) {
                          if (!on && _shown.length == 1) return;
                          setState(
                            () => on ? _shown.add(layer) : _shown.remove(layer),
                          );
                          unawaited(_load());
                        },
                      ),
                    FilterChip(
                      key: const ValueKey('map-open-now'),
                      avatar: const Icon(Icons.schedule, size: 18),
                      label: Text(l10n.mapOpenNow),
                      selected: _openNow,
                      onSelected: (on) {
                        setState(() => _openNow = on);
                        unawaited(_load());
                      },
                    ),
                  ],
                ),
              ),
              IconButton(
                key: const ValueKey('map-list'),
                tooltip: l10n.mapList,
                icon: const Icon(Icons.list_alt_outlined),
                onPressed: () => _openList(l10n, locale),
              ),
            ],
          ),
        ),
        for (final notice in [
          if (points?.clipped ?? false) l10n.mapClipped,
          if (points?.truncated ?? false) l10n.mapTruncated,
          if (points != null && points.openNowSkipped.isNotEmpty)
            l10n.mapOpenNowSkipped(
              points.openNowSkipped.map((l) => _layerLabel(l10n, l)).join(', '),
            ),
          if (_failed) l10n.mapLoadFailed,
        ])
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Text(notice, style: theme.textTheme.bodySmall),
          ),
        const SizedBox(height: AppSpacing.xs),
        Expanded(
          child: Stack(
            children: [
              BaseMap(
                initialCenter: _center,
                initialZoom: _initialZoom,
                onMapCreated: _onMapCreated,
                onStyleLoaded: (map) => unawaited(_onStyleLoaded(map)),
                onCameraIdle: (position) => unawaited(_onCameraIdle(position)),
              ),
              if (_selected case final item?)
                Positioned(
                  left: AppSpacing.sm,
                  right: AppSpacing.sm,
                  bottom: AppSpacing.xl,
                  child: _PointCard(
                    key: const ValueKey('map-card'),
                    item: item,
                    route: _route,
                    routeState: _routeState,
                    distance: (m) => _distance(l10n, m, locale),
                    onClose: () => setState(() => _selected = null),
                    onRoute: (mode) => unawaited(_showRoute(mode)),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PointCard extends StatelessWidget {
  const _PointCard({
    required this.item,
    required this.route,
    required this.routeState,
    required this.distance,
    required this.onClose,
    required this.onRoute,
    super.key,
  });

  final api.MapFeature item;
  final api.RouteAnswer? route;
  final _RouteState routeState;
  final String Function(double meters) distance;
  final VoidCallback onClose;
  final void Function(String mode) onRoute;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final card = item.properties;
    final name = card.nameBn ?? card.nameEn;
    final route = this.route;

    return Material(
      elevation: 4,
      borderRadius: AppRadii.mdRadius,
      color: theme.colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name ?? l10n.mapUnnamed,
                        style: theme.textTheme.titleMedium,
                      ),
                      Text(
                        _MapScreenState._layerLabel(l10n, card.layer),
                        style: theme.textTheme.bodySmall,
                      ),
                      if (card.openNow case final open?)
                        Text(
                          open ? l10n.mapIsOpen : l10n.mapIsClosed,
                          style: theme.textTheme.bodySmall,
                        ),
                      if (card.price case final price?)
                        Text('৳ ${formatMoney(price, locale)}'),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                  icon: const Icon(Icons.close),
                  onPressed: onClose,
                ),
              ],
            ),
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                if (card.layer == 'posts' && card.id != null)
                  FilledButton(
                    onPressed: () =>
                        context.push(RoutePaths.postDetailFor(card.id!)),
                    child: Text(l10n.mapOpen),
                  ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.directions_walk),
                  label: Text(l10n.mapRouteWalk),
                  onPressed: () => onRoute('foot'),
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.directions_car),
                  label: Text(l10n.mapRouteCar),
                  onPressed: () => onRoute('car'),
                ),
              ],
            ),
            switch (routeState) {
              _RouteState.loading => Text(l10n.mapRouting),
              _RouteState.needsLocation => Text(l10n.mapRouteNeedsLocation),
              _RouteState.limited => Text(l10n.mapRouteLimited),
              _RouteState.failed => Text(l10n.mapRouteFailed),
              _RouteState.idle when route != null => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    key: const ValueKey('map-route'),
                    route.durationSeconds == null
                        ? l10n.mapRouteStraight(distance(route.distanceMeters))
                        : l10n.mapRouteResult(
                            distance(route.distanceMeters),
                            localizeDigits(
                              '${math.max(1, (route.durationSeconds! / _secondsPerMinute).round())}',
                              locale,
                            ),
                          ),
                  ),
                  if (route.source == 'barikoi') const BarikoiAttribution(),
                ],
              ),
              _ => const SizedBox.shrink(),
            },
          ],
        ),
      ),
    );
  }
}
