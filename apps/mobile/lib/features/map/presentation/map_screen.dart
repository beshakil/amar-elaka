import 'dart:async';
import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/base_map.dart';
import '../../../core/map/directions.dart';
import '../../../core/map/map_config_provider.dart';
import '../../../core/map/map_pin_images.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/current_tenant.dart';
import '../../post_detail/application/contact_actions.dart';
import '../../tenant_bootstrap/data/location_service.dart';
import '../application/map_viewport.dart';
import '../application/route_cache.dart';
import 'map_layers_sheet.dart';
import 'map_preview_sheet.dart';

typedef _Point = ({double lat, double lng});

const _source = 'ae-features';
const _clusterLayer = 'ae-clusters';
const _clusterCountLayer = 'ae-cluster-count';
const _pinLayer = 'ae-pins';
const _labelLayer = 'ae-pin-labels';

const _initialZoom = 14.0;
// Web Mercator facts: 256 px tiles; 360 degrees of longitude per world width.
const _tilePx = 256.0;
const _degreesAround = 360.0;
const _routeMode = 'car';

const _emptyCollection = {'type': 'FeatureCollection', 'features': <Object>[]};

/// Drives the Map tab from the camera: the native map does in the app, tests
/// do directly (no platform view in widget tests).
class MapScreenController {
  _MapScreenState? _state;

  /// The camera came to rest showing [box] at [zoom].
  void cameraIdle(LatLngBox box, double zoom) =>
      _state?._onCameraIdle(box, zoom);
}

/// The Map tab (ADR 046) on our own base map (ADR 043):
///
/// * opens at the user's location, the area's centre as fallback;
/// * features from GET /map/features (ADR 045) — clustered on the server,
///   our own data only — for the toggled `map_kinds` and "open now";
/// * fetched on open, on a toggle change and on a cluster tap; a pan only
///   offers "এই এলাকায় খুঁজুন" (no refetch per pan);
/// * pins are icons (style images drawn by Flutter); from
///   `map_pin_label_min_zoom` the nearest `map_pin_label_max` pins also carry
///   their Bengali name as an image — never map text;
/// * a pin opens a preview sheet (photo, name, distance, open/closed, call,
///   directions, "রাস্তায় কত দূর?" — one paid route per place per session);
/// * map / list show the same results;
/// * OpenStreetMap + Protomaps credit always on the map; Barikoi's where its
///   answer is shown.
class MapScreen extends ConsumerStatefulWidget {
  const MapScreen({this.controller, super.key});

  final MapScreenController? controller;

  @override
  ConsumerState<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends ConsumerState<MapScreen> {
  MapLibreMapController? _map;
  bool _styleReady = false;

  Set<String>? _kinds;
  bool _openNow = false;

  api.MapFeatures? _features;
  bool _loading = false;
  bool _failed = false;
  int _request = 0;

  /// What the shown features were fetched for, and where the camera is.
  LatLngBox? _fetchedBox;
  double _fetchedZoom = _initialZoom;
  LatLngBox? _box;
  double _zoom = _initialZoom;
  bool _offerSearch = false;
  bool _fetchOnIdle = false;

  _Point? _user;
  bool _showList = false;
  final _labels = PinLabelCache();
  final _labelOf = <String, String>{};

  @override
  void initState() {
    super.initState();
    widget.controller?._state = this;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_start());
    });
  }

  @override
  void dispose() {
    if (widget.controller?._state == this) widget.controller?._state = null;
    super.dispose();
  }

  _Point get _center {
    final center = ref.read(currentTenantConfigProvider)?.mapCenter;
    // Bootstrapped apps always have a tenant; Dhaka only for a bare test/edge case.
    return center == null
        ? (lat: 23.8103, lng: 90.4125)
        : (lat: center.lat, lng: center.lng);
  }

  api.MapConfig? get _config => ref.read(mapConfigProvider).asData?.value;

  /// One request on open: where (the user, else the area's centre) and
  /// which kinds (GET /map/config) are settled first.
  Future<void> _start() async {
    final located = await ref
        .read(locationServiceProvider)
        .requestAndGetPosition();
    try {
      await ref.read(mapConfigProvider.future);
    } on Object {
      // No config: features of every kind; the map itself shows its notice.
    }
    if (!mounted) return;
    final start = switch (located) {
      LocationGranted(:final latitude, :final longitude) => (
        lat: latitude,
        lng: longitude,
      ),
      _ => _center,
    };
    if (located is LocationGranted) setState(() => _user = start);
    _box = _viewportAround(start, _zoom, MediaQuery.sizeOf(context));
    final map = _map;
    if (map != null && located is LocationGranted) {
      unawaited(
        map.animateCamera(
          CameraUpdate.newLatLngZoom(LatLng(start.lat, start.lng), _zoom),
        ),
      );
    }
    await _load();
  }

  static LatLngBox _viewportAround(_Point center, double zoom, Size size) {
    final degreesPerPx = _degreesAround / (_tilePx * math.pow(2, zoom));
    final halfLng = size.width / 2 * degreesPerPx;
    final halfLat =
        size.height / 2 * degreesPerPx * math.cos(center.lat * math.pi / 180);
    return (
      minLng: center.lng - halfLng,
      minLat: center.lat - halfLat,
      maxLng: center.lng + halfLng,
      maxLat: center.lat + halfLat,
    );
  }

  // ---- data -----------------------------------------------------------------

  Future<void> _load() async {
    final box = _box;
    if (box == null) return;
    final id = ++_request;
    final zoom = _zoom;
    setState(() {
      _loading = true;
      _offerSearch = false;
    });
    try {
      final features = await ref
          .read(mapApiProvider)
          .features(
            bbox: box,
            zoom: zoom,
            // The toggles; until one is changed, every kind of map_kinds.
            kinds: _kinds ?? _config?.kinds.map((k) => k.code).toSet(),
            openNow: _openNow,
          );
      if (!mounted || id != _request) return;
      setState(() {
        _features = features;
        _fetchedBox = box;
        _fetchedZoom = zoom;
        _failed = false;
        _loading = false;
      });
      _labelOf.clear();
      await _draw();
      await _updateLabels();
    } on AppException {
      if (mounted && id == _request) {
        setState(() {
          _failed = true;
          _loading = false;
        });
      }
    }
  }

  /// The features as the map's GeoJSON source: the API's, plus each pin's
  /// style image name and its name image (when it has one).
  Map<String, dynamic> _collection() {
    final kinds = {
      for (final k in _config?.kinds ?? <api.MapKind>[]) k.code: k,
    };
    final features = _features?.features ?? const <api.MapFeature>[];
    return {
      'type': 'FeatureCollection',
      'features': [
        for (final (index, feature) in features.indexed)
          {
            ...feature.toJson(),
            // MapLibre hands a tapped feature's id back: its index here.
            'id': index,
            'properties': {
              ...feature.properties.toJson(),
              'icon': MapPinImages.imageName(
                kinds[feature.properties.kind]?.icon,
              ),
              'colour': _hex(
                MapPinImages.colourFor(kinds[feature.properties.kind]?.icon),
              ),
              'label': ?_labelOf[feature.properties.id],
            },
          },
      ],
    };
  }

  static String _hex(Color colour) =>
      '#${(colour.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

  Future<void> _draw() async {
    final map = _map;
    if (map == null || !_styleReady) return;
    await map.setGeoJsonSource(_source, _collection());
  }

  // ---- camera ---------------------------------------------------------------

  void _onCameraIdle(LatLngBox box, double zoom) {
    _box = box;
    _zoom = zoom;
    if (_fetchOnIdle) {
      _fetchOnIdle = false;
      unawaited(_load());
      return;
    }
    final fetched = _fetchedBox;
    final client = _config?.client;
    if (fetched != null && client != null) {
      final moved = movedEnough(
        fetched: fetched,
        fetchedZoom: _fetchedZoom,
        now: box,
        nowZoom: zoom,
        ratio: client.searchAreaMoveRatio,
      );
      if (moved != _offerSearch) setState(() => _offerSearch = moved);
    }
    unawaited(_updateLabels());
  }

  Future<void> _onNativeCameraIdle(CameraPosition? position) async {
    final map = _map;
    if (map == null || position == null) return;
    final region = await map.getVisibleRegion();
    _onCameraIdle((
      minLng: region.southwest.longitude,
      minLat: region.southwest.latitude,
      maxLng: region.northeast.longitude,
      maxLat: region.northeast.latitude,
    ), position.zoom);
  }

  /// From `map_pin_label_min_zoom`, the nearest `map_pin_label_max` pins
  /// get their Bengali name — drawn by Flutter, one image slot each. Only
  /// at rest, never while the camera moves.
  Future<void> _updateLabels() async {
    final map = _map;
    final client = _config?.client;
    final box = _box;
    final features = _features?.features;
    if (map == null || !_styleReady || client == null || box == null) return;
    if (features == null || _zoom < client.pinLabelMinZoom) {
      if (_labelOf.isEmpty) return;
      _labelOf.clear();
      await _draw();
      return;
    }
    final centre = (
      lat: (box.minLat + box.maxLat) / 2,
      lng: (box.minLng + box.maxLng) / 2,
    );
    double d2(api.MapFeature f) =>
        math.pow(f.lat - centre.lat, 2) + math.pow(f.lng - centre.lng, 2)
            as double;
    final named =
        features
            .where(
              (f) =>
                  !f.isCluster &&
                  (f.properties.nameBn ?? f.properties.nameEn) != null,
            )
            .toList()
          ..sort((a, b) => d2(a).compareTo(d2(b)));
    final pick = named.take(client.pinLabelMax);
    if (!mounted) return;
    final theme = Theme.of(context);
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final next = <String, String>{};
    for (final feature in pick) {
      final id = feature.properties.id!;
      final slot = _labels.assign(id, client.pinLabelMax);
      final name = PinLabelCache.imageName(slot.slot);
      if (slot.draw) {
        final bytes = await MapPinImages.label(
          feature.properties.nameBn ?? feature.properties.nameEn!,
          pixelRatio: ratio,
          style: theme.textTheme.labelMedium!.copyWith(
            color: theme.colorScheme.onSurface,
          ),
          background: theme.colorScheme.surface.withValues(alpha: 0.9),
        );
        await map.addImage(name, bytes);
      }
      next[id] = name;
    }
    if (!mounted) return;
    _labelOf
      ..clear()
      ..addAll(next);
    await _draw();
  }

  // ---- map --------------------------------------------------------------------

  void _onMapCreated(MapLibreMapController controller) {
    _map = controller;
    controller.onFeatureTapped.add((point, latLng, id, layerId, annotation) {
      if (layerId != _clusterLayer && layerId != _pinLayer) return;
      final index = int.tryParse(id);
      final features = _features?.features;
      if (index == null || features == null || index >= features.length) {
        return;
      }
      _activate(features[index]);
    });
    final user = _user;
    if (user != null) {
      unawaited(
        controller.moveCamera(
          CameraUpdate.newLatLngZoom(LatLng(user.lat, user.lng), _zoom),
        ),
      );
    }
  }

  /// Our images, source and layers over the base map; again after every
  /// style change (theme), which drops them.
  Future<void> _onStyleLoaded(MapLibreMapController map) async {
    _styleReady = false;
    _labels.clear();
    _labelOf.clear();
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final icons = {
      for (final k in _config?.kinds ?? <api.MapKind>[]) k.icon,
      null,
    };
    for (final icon in icons) {
      await map.addImage(
        MapPinImages.imageName(icon),
        await MapPinImages.pin(icon, pixelRatio: ratio),
      );
    }
    await map.addGeoJsonSource(_source, _emptyCollection);
    await map.addCircleLayer(
      _source,
      _clusterLayer,
      const CircleLayerProperties(
        circleColor: ['get', 'colour'],
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
      _source,
      _clusterCountLayer,
      const SymbolLayerProperties(
        // Digits only: no Bengali shaping needed.
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
    await map.addSymbolLayer(
      _source,
      _labelLayer,
      const SymbolLayerProperties(
        iconImage: ['get', 'label'],
        iconAnchor: 'top',
        iconOffset: [0, 16],
        iconAllowOverlap: false,
      ),
      filter: ['has', 'label'],
      enableInteraction: false,
    );
    await map.addSymbolLayer(
      _source,
      _pinLayer,
      const SymbolLayerProperties(
        iconImage: ['get', 'icon'],
        iconAllowOverlap: true,
      ),
      filter: [
        '==',
        ['get', 'cluster'],
        false,
      ],
    );
    _styleReady = true;
    await _draw();
    await _updateLabels();
  }

  // ---- actions ----------------------------------------------------------------

  void _activate(api.MapFeature feature) {
    if (feature.isCluster) {
      // An explicit tap: zoom in and fetch for where it lands.
      _fetchOnIdle = true;
      final zoom = (feature.properties.expansionZoom ?? _zoom + 1).toDouble();
      final map = _map;
      if (map != null) {
        unawaited(
          map.animateCamera(
            CameraUpdate.newLatLngZoom(LatLng(feature.lat, feature.lng), zoom),
          ),
        );
      } else {
        _zoom = zoom;
        _box = _viewportAround(
          (lat: feature.lat, lng: feature.lng),
          zoom,
          MediaQuery.sizeOf(context),
        );
        _fetchOnIdle = false;
        unawaited(_load());
      }
      return;
    }
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) => _PreviewLoader(feature: feature, user: _user),
      ),
    );
  }

  Future<void> _chooseLayers() async {
    final config = _config;
    if (config == null) return;
    final choice = await showMapLayersSheet(
      context,
      kinds: config.kinds,
      selected: _kinds ?? {for (final k in config.kinds) k.code},
      openNow: _openNow,
    );
    if (choice == null || !mounted) return;
    setState(() {
      _kinds = choice.kinds;
      _openNow = choice.openNow;
    });
    await _load();
  }

  String _clusterTitle(
    AppLocalizations l10n,
    api.MapFeature feature,
    String locale,
  ) {
    final kind = _config?.kinds
        .where((k) => k.code == feature.properties.kind)
        .firstOrNull;
    return l10n.mapClusterItem(
      localizeDigits('${feature.properties.count}', locale),
      kind == null
          ? l10n.mapKindOther
          : (locale == 'bn' ? kind.label.bn : kind.label.en),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final features = _features;
    // The kinds and timings live in GET /map/config: keep it loaded.
    ref.watch(mapConfigProvider);

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
              SegmentedButton<bool>(
                key: const ValueKey('map-view-toggle'),
                segments: [
                  ButtonSegment(
                    value: false,
                    icon: const Icon(Icons.map_outlined),
                    label: Text(l10n.mapViewMap),
                  ),
                  ButtonSegment(
                    value: true,
                    icon: const Icon(Icons.list),
                    label: Text(l10n.mapViewList),
                  ),
                ],
                selected: {_showList},
                onSelectionChanged: (value) =>
                    setState(() => _showList = value.single),
              ),
              const Spacer(),
              TextButton.icon(
                key: const ValueKey('map-layers'),
                icon: const Icon(Icons.layers_outlined),
                label: Text(l10n.mapLayersButton),
                onPressed: _chooseLayers,
              ),
            ],
          ),
        ),
        for (final notice in [
          if (features?.clipped ?? false) l10n.mapClipped,
          if (features?.truncated ?? false) l10n.mapTruncated,
          if (_failed) l10n.mapLoadFailed,
        ])
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Text(notice, style: theme.textTheme.bodySmall),
          ),
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: Stack(
            children: [
              // Kept alive under the list, so switching back is instant.
              Offstage(
                offstage: _showList,
                child: BaseMap(
                  initialCenter: LatLng(_center.lat, _center.lng),
                  initialZoom: _initialZoom,
                  onMapCreated: _onMapCreated,
                  onStyleLoaded: (map) => unawaited(_onStyleLoaded(map)),
                  onCameraIdle: (position) =>
                      unawaited(_onNativeCameraIdle(position)),
                ),
              ),
              if (_showList)
                _ResultList(
                  features: features?.features ?? const [],
                  user: _user,
                  clusterTitle: (f) => _clusterTitle(l10n, f, locale),
                  onTap: _activate,
                ),
              if (_offerSearch)
                Positioned(
                  top: AppSpacing.sm,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: FilledButton.tonalIcon(
                      key: const ValueKey('map-search-area'),
                      icon: const Icon(Icons.refresh),
                      label: Text(l10n.mapSearchThisArea),
                      onPressed: () => unawaited(_load()),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The same results as the map, nearest first (from the user, else in the
/// API's order), clusters as "N items — zoom in".
class _ResultList extends StatelessWidget {
  const _ResultList({
    required this.features,
    required this.user,
    required this.clusterTitle,
    required this.onTap,
  });

  final List<api.MapFeature> features;
  final _Point? user;
  final String Function(api.MapFeature) clusterTitle;
  final void Function(api.MapFeature) onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    if (features.isEmpty) {
      return Material(
        color: theme.colorScheme.surface,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Text(l10n.mapEmpty, textAlign: TextAlign.center),
          ),
        ),
      );
    }
    final sorted = [...features];
    final from = user;
    if (from != null) {
      double d2(api.MapFeature f) =>
          math.pow(f.lat - from.lat, 2) + math.pow(f.lng - from.lng, 2)
              as double;
      sorted.sort((a, b) => d2(a).compareTo(d2(b)));
    }
    return Material(
      color: theme.colorScheme.surface,
      child: ListView.builder(
        key: const ValueKey('map-list'),
        itemCount: sorted.length,
        itemBuilder: (context, index) {
          final f = sorted[index];
          return ListTile(
            leading: Icon(
              f.isCluster ? Icons.bubble_chart_outlined : Icons.place_outlined,
            ),
            title: Text(
              f.isCluster
                  ? clusterTitle(f)
                  : (f.properties.nameBn ??
                        f.properties.nameEn ??
                        l10n.mapUnnamed),
            ),
            onTap: () => onTap(f),
          );
        },
      ),
    );
  }
}

/// The preview sheet's requests: the preview and the straight-line distance
/// on open (both our own data), the road only on its button (session cache).
class _PreviewLoader extends ConsumerStatefulWidget {
  const _PreviewLoader({required this.feature, required this.user});

  final api.MapFeature feature;
  final _Point? user;

  @override
  ConsumerState<_PreviewLoader> createState() => _PreviewLoaderState();
}

class _PreviewLoaderState extends ConsumerState<_PreviewLoader> {
  api.MapPreview? _preview;
  bool _loading = true;
  bool _failed = false;
  double? _straight;
  RoadState _road = const RoadIdle();

  api.MapFeatureProperties get _props => widget.feature.properties;

  @override
  void initState() {
    super.initState();
    unawaited(_loadPreview());
    unawaited(_loadDistance());
    // Reopened: a road already asked for this session shows at once.
    final cached = ref.read(routeCacheProvider).cached(_props.id!, _routeMode);
    if (cached != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_showRoad(cached));
      });
    }
  }

  Future<void> _loadPreview() async {
    try {
      final preview = await ref
          .read(mapApiProvider)
          .preview(
            layer: _props.layer,
            id: _props.id!,
            tenantId: _props.tenantId!,
          );
      if (mounted) {
        setState(() {
          _preview = preview;
          _loading = false;
        });
      }
    } on AppException {
      if (mounted) {
        setState(() {
          _failed = true;
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadDistance() async {
    final user = widget.user;
    if (user == null) return;
    try {
      final distance = await ref
          .read(mapApiProvider)
          .distance(
            fromLat: user.lat,
            fromLng: user.lng,
            toLat: widget.feature.lat,
            toLng: widget.feature.lng,
          );
      if (mounted) setState(() => _straight = distance.straightLineMeters);
    } on AppException {
      // The distance is a nicety; the sheet works without it.
    }
  }

  Future<void> _askRoad() async {
    final user = widget.user;
    if (user == null) return;
    await _showRoad(
      ref
          .read(routeCacheProvider)
          .route(
            featureId: _props.id!,
            mode: _routeMode,
            fromLat: user.lat,
            fromLng: user.lng,
            toLat: widget.feature.lat,
            toLng: widget.feature.lng,
          ),
    );
  }

  Future<void> _showRoad(Future<api.RouteAnswer> answer) async {
    final l10n = AppLocalizations.of(context)!;
    setState(() => _road = const RoadLoading());
    try {
      final route = await answer;
      if (mounted) setState(() => _road = RoadAnswered(route));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(
        () => _road = RoadFailed(
          e.statusCode == 429 ? l10n.mapRouteLimited : l10n.mapRouteFailed,
        ),
      );
    } on AppException {
      if (mounted) setState(() => _road = RoadFailed(l10n.mapRouteFailed));
    }
  }

  Future<void> _directions() async {
    final opened = await Directions.open(
      ref.read(externalAppsProvider),
      widget.feature.lat,
      widget.feature.lng,
    );
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context)!.mapDirectionsFailed),
        ),
      );
    }
  }

  /// A post: through its contact action (the lead). Others: the first public
  /// number, straight to the dialer.
  Future<void> _call() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    bool ok;
    if (_props.layer == 'posts') {
      final outcome = await ref.read(contactActionsProvider).call(_props.id!);
      ok = outcome is ContactOpened;
    } else {
      final phone = _preview!.phones.first;
      ok = await ref
          .read(externalAppsProvider)
          .open(Uri(scheme: 'tel', path: phone));
    }
    if (!ok && mounted) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.mapCallFailed)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final kind = ref
        .watch(mapConfigProvider)
        .asData
        ?.value
        .kinds
        .where((k) => k.code == _props.kind)
        .firstOrNull;
    final canCall =
        _props.layer == 'posts' || (_preview?.phones.isNotEmpty ?? false);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MapPreviewSheet(
          feature: widget.feature,
          kind: kind,
          preview: _preview,
          loading: _loading,
          failed: _failed,
          straightMeters: _straight,
          road: _road,
          onRoad: widget.user == null ? null : () => unawaited(_askRoad()),
          onDirections: () => unawaited(_directions()),
          onCall: canCall ? () => unawaited(_call()) : null,
        ),
        if (_props.layer == 'posts')
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md,
              0,
              AppSpacing.md,
              AppSpacing.md,
            ),
            child: TextButton(
              key: const ValueKey('map-preview-open-post'),
              onPressed: () =>
                  context.push(RoutePaths.postDetailFor(_props.id!)),
              child: Text(AppLocalizations.of(context)!.mapOpen),
            ),
          ),
      ],
    );
  }
}
