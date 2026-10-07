import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../../features/offline_map/data/offline_map_repository.dart';
import '../../features/post/application/current_tenant.dart';
import '../../features/tenant_bootstrap/data/location_service.dart';
import '../../l10n/app_localizations.dart';
import '../design/tokens/app_spacing.dart';
import '../design/widgets/app_text_field.dart';
import '../network/api_exception.dart';
import 'barikoi_attribution.dart';
import 'base_map.dart';
import 'geo_api.dart';
import 'map_config_provider.dart';

/// A point as callers store it: the exact doubles from GPS, a draft or a
/// search result. MapLibre's [LatLng] wraps longitudes with float arithmetic
/// (90.3687 → 90.36869999999999), so it is used for the camera only.
typedef GeoPoint = ({double lat, double lng});

/// What the user chose: the point, our own area name for it, and the
/// address text as they confirmed it (possibly edited; possibly empty).
@immutable
class PickedLocation {
  const PickedLocation({
    required this.point,
    required this.areaLabel,
    required this.addressText,
  });

  final GeoPoint point;

  /// Union, upazila, district from our geo_areas — always free.
  final String? areaLabel;

  /// The street address the user saw and kept or edited: what gets saved.
  final String addressText;

  /// What a caller saves as the place's label: the confirmed text, else the area.
  String? get label => addressText.isNotEmpty ? addressText : areaLabel;
}

/// Feeds the picker the map's camera events. The widget wires it to the
/// native map; tests drive it directly (no platform view in widget tests).
class LocationPickerController {
  _LocationPickerState? _state;

  /// The camera moved (every frame while it moves).
  void cameraMoving() => _state?._onCameraMoving();

  /// The camera came to rest at [target].
  void cameraIdle(GeoPoint target) => _state?._onCameraIdle(target);
}

const _initialZoom = 16.0;

/// A millionth of a degree (~0.1 m): the camera settled where it was sent.
const _samePoint = 1e-6;

/// Reusable "where is it?" picker (ADR 046) — post creation, store setup,
/// place marking.
///
/// * The pin is fixed in the middle; the map moves under it (cheaper and
///   steadier than dragging a marker).
/// * When the camera stops — and stays still for `geo_picker_idle_debounce_ms`
///   (GET /map/config) — the point is looked up ONCE: our own area name at
///   once (`/locations/lookup`, free), the street address from
///   `/geo/reverse?purpose=<purpose>` when it arrives. Frames, jitter and
///   repeated idles never cost extra calls.
/// * Address search (`/geo/autocomplete`, debounced, minimum length from
///   settings) shows our own results first.
/// * The address text is editable; [PickedLocation.addressText] is what the
///   user confirmed.
/// * When the geo endpoints fail, the pin and the area name are enough to
///   continue.
class LocationPicker extends ConsumerStatefulWidget {
  const LocationPicker({
    required this.purpose,
    required this.onChanged,
    this.initial,
    this.controller,
    this.onPointSettled,
    this.below,
    this.onConfirm,
    super.key,
  });

  /// `/geo/reverse` purpose: post_location | store_setup | place_marking.
  final String purpose;

  /// The starting point (a draft's); null = the phone's location, else the
  /// area's centre.
  final GeoPoint? initial;

  /// Every change of point, area or address text.
  final ValueChanged<PickedLocation> onChanged;

  final LocationPickerController? controller;

  /// Each newly settled point, for the caller's own checks (e.g. a tenant
  /// boundary warning shown through [below]).
  final ValueChanged<GeoPoint>? onPointSettled;

  /// Caller content under the address (warnings, a required notice).
  final Widget? below;

  /// Shows a confirm button when set (a step's "next" can confirm instead).
  final ValueChanged<PickedLocation>? onConfirm;

  @override
  ConsumerState<LocationPicker> createState() => _LocationPickerState();
}

class _LocationPickerState extends ConsumerState<LocationPicker> {
  MapLibreMapController? _map;
  final _search = TextEditingController();
  final _addressText = TextEditingController();
  Timer? _idle;
  Timer? _searchDebounce;

  /// Where the app last sent the camera: its idle is not a new stop.
  GeoPoint? _movedTo;

  /// A point chosen before the map existed (a GPS fix on the first frame).
  GeoPoint? _pendingCenter;
  GeoPoint? _point;
  int _lookup = 0;

  String? _area;
  api.ReverseGeocode? _reverse;
  bool _addressFromProvider = false;
  bool _edited = false;
  bool _lookingUp = false;
  String? _notice;
  List<api.GeocodeResult>? _results;

  /// The last search couldn't reach the server.
  bool _searchOffline = false;

  api.MapClientConfig? get _client =>
      ref.read(mapConfigProvider).asData?.value.client;

  @override
  void initState() {
    super.initState();
    widget.controller?._state = this;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final initial = widget.initial;
      if (initial != null) {
        _moveTo(initial);
      } else {
        unawaited(_useMyLocation(initial: true));
      }
    });
  }

  @override
  void didUpdateWidget(LocationPicker old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller?._state = null;
      widget.controller?._state = this;
    }
  }

  @override
  void dispose() {
    if (widget.controller?._state == this) widget.controller?._state = null;
    _idle?.cancel();
    _searchDebounce?.cancel();
    _search.dispose();
    _addressText.dispose();
    super.dispose();
  }

  GeoPoint get _fallbackCenter {
    final center = ref.read(currentTenantConfigProvider)?.mapCenter;
    // Bootstrapped apps always have a tenant; Dhaka only for a bare test/edge case.
    return center == null
        ? (lat: 23.8103, lng: 90.4125)
        : (lat: center.lat, lng: center.lng);
  }

  // ---- camera ---------------------------------------------------------------

  void _onCameraMoving() => _idle?.cancel();

  void _onCameraIdle(GeoPoint target) {
    final movedTo = _movedTo;
    if (movedTo != null &&
        (target.lat - movedTo.lat).abs() < _samePoint &&
        (target.lng - movedTo.lng).abs() < _samePoint) {
      return;
    }
    _idle?.cancel();
    // No config (the API is unreachable): look up at once; it will fail
    // gracefully anyway.
    final wait = _client?.pickerIdleDebounce ?? Duration.zero;
    _idle = Timer(wait, () {
      if (!mounted) return;
      _movedTo = target;
      unawaited(_settle(target));
    });
  }

  /// The app moves the camera (GPS, a search result, the start): that point
  /// is settled now — no debounce, and its idle is ignored.
  void _moveTo(GeoPoint point, {String? knownAddress}) {
    _idle?.cancel();
    _movedTo = point;
    final map = _map;
    if (map == null) {
      _pendingCenter = point;
    } else {
      unawaited(
        map.animateCamera(
          CameraUpdate.newLatLngZoom(
            LatLng(point.lat, point.lng),
            _initialZoom,
          ),
        ),
      );
    }
    unawaited(_settle(point, knownAddress: knownAddress));
  }

  void _onMapCreated(MapLibreMapController controller) {
    _map = controller;
    final pending = _pendingCenter;
    _pendingCenter = null;
    if (pending != null) {
      unawaited(
        controller.moveCamera(
          CameraUpdate.newLatLngZoom(
            LatLng(pending.lat, pending.lng),
            _initialZoom,
          ),
        ),
      );
    }
  }

  // ---- lookups --------------------------------------------------------------

  /// One stop, one lookup: the area at once, the street address when it
  /// arrives (skipped when a search result already named the place). The
  /// latest stop wins; answers for points already left are dropped.
  Future<void> _settle(GeoPoint point, {String? knownAddress}) async {
    final requestId = ++_lookup;
    final geo = ref.read(geoApiProvider);
    final locale = Localizations.localeOf(context).languageCode;
    final l10n = AppLocalizations.of(context)!;
    setState(() {
      _point = point;
      _area = null;
      _reverse = null;
      _notice = null;
      _edited = false;
      _addressFromProvider = false;
      _addressText.text = knownAddress ?? '';
      _lookingUp = knownAddress == null;
    });
    _emit();
    widget.onPointSettled?.call(point);

    unawaited(
      geo
          .areasAt(point.lat, point.lng)
          .then((areas) {
            if (!mounted || requestId != _lookup) return;
            setState(() => _area = areaLabel(areas.areas, locale));
            _emit();
          })
          .catchError((Object _) async {
            // No network: name it from the downloaded area outlines.
            final label = await _offlineAreaLabel(point, locale);
            if (!mounted || requestId != _lookup || label == null) return;
            setState(() => _area ??= label);
            _emit();
          }),
    );
    if (knownAddress != null) return;

    try {
      final reverse = await geo.reverse(
        point.lat,
        point.lng,
        purpose: widget.purpose,
      );
      if (!mounted || requestId != _lookup) return;
      final address = reverse.address;
      setState(() {
        _reverse = reverse;
        _lookingUp = false;
        _area ??= areaLabel(reverse.areas, locale);
        if (!_edited && address != null) {
          _addressText.text = locale == 'bn'
              ? (address.labelBn ?? address.label)
              : address.label;
          _addressFromProvider = address.source == 'barikoi';
        }
      });
      _emit();
    } on AppException catch (e) {
      if (!mounted || requestId != _lookup) return;
      setState(() {
        _lookingUp = false;
        _notice = e is NetworkException || e is TimeoutException
            ? l10n.locationPickerOffline
            : l10n.locationPickerAddressFailed;
      });
    }
  }

  /// The area's name from the downloaded map (ADR 050); null without one.
  Future<String?> _offlineAreaLabel(GeoPoint point, String locale) async {
    final tenantId = ref.read(currentTenantConfigProvider)?.id;
    if (tenantId == null) return null;
    try {
      final index = await ref
          .read(offlineMapRepositoryProvider)
          .areas(tenantId);
      return index?.label(point.lat, point.lng, locale);
    } on Object {
      return null;
    }
  }

  /// Union, upazila, district (nearest first) in the reader's script.
  static String? areaLabel(List<api.GeoArea> areas, String locale) {
    final names = areas.reversed
        .where((a) => a.level != 'country' && a.level != 'division')
        .take(3)
        .map((a) => a.name.of(locale));
    return names.isEmpty ? null : names.join(', ');
  }

  void _emit() {
    final point = _point;
    if (point == null) return;
    widget.onChanged(_picked(point));
  }

  PickedLocation _picked(GeoPoint point) => PickedLocation(
    point: point,
    areaLabel: _area,
    addressText: _addressText.text.trim(),
  );

  Future<void> _useMyLocation({bool initial = false}) async {
    final l10n = AppLocalizations.of(context)!;
    final result = await ref
        .read(locationServiceProvider)
        .requestAndGetPosition();
    if (!mounted) return;
    switch (result) {
      case LocationGranted(:final latitude, :final longitude):
        _moveTo((lat: latitude, lng: longitude));
      case LocationDenied() || LocationPermanentlyDenied():
        if (initial) _moveTo(_fallbackCenter);
        setState(() => _notice = l10n.locationPickerPermissionDenied);
      case LocationServiceDisabled():
        if (initial) _moveTo(_fallbackCenter);
        setState(() => _notice = l10n.locationPickerServiceOff);
      case LocationError():
        if (initial) _moveTo(_fallbackCenter);
    }
  }

  // ---- search ---------------------------------------------------------------

  void _onSearchChanged(String text) {
    _searchDebounce?.cancel();
    final query = text.trim();
    final client = _client;
    if (query.isEmpty ||
        (client != null && query.runes.length < client.autocompleteMinChars)) {
      setState(() {
        _results = null;
        _searchOffline = false;
      });
      return;
    }
    _searchDebounce = Timer(
      client?.autocompleteDebounce ?? Duration.zero,
      () async {
        final near = _point;
        try {
          final response = await ref
              .read(geoApiProvider)
              .autocomplete(query, lat: near?.lat, lng: near?.lng);
          if (!mounted || _search.text.trim() != query) return;
          // Our own places first, whatever order they came in.
          final results = [
            ...response.results.where((r) => r.source != 'barikoi'),
            ...response.results.where((r) => r.source == 'barikoi'),
          ];
          setState(() {
            _results = results;
            _searchOffline = false;
          });
        } on AppException catch (e) {
          if (!mounted) return;
          setState(() {
            _results = const [];
            _searchOffline = e is NetworkException || e is TimeoutException;
          });
        }
      },
    );
  }

  void _pickResult(api.GeocodeResult result, String locale) {
    FocusScope.of(context).unfocus();
    _search.clear();
    setState(() {
      _results = null;
      _searchOffline = false;
    });
    _moveTo(
      (lat: result.location.lat, lng: result.location.lng),
      knownAddress: locale == 'bn'
          ? (result.labelBn ?? result.label)
          : result.label,
    );
  }

  // ---- view -----------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final start = _pendingCenter ?? widget.initial ?? _fallbackCenter;
    // The timings live in GET /map/config: keep it loaded (and current).
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
          child: AppTextField(
            key: const ValueKey('location-search'),
            label: l10n.locationPickerSearchHint,
            controller: _search,
            prefixIcon: Icons.search,
            textInputAction: TextInputAction.search,
            onChanged: _onSearchChanged,
          ),
        ),
        if (_results case final results?)
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 220),
            child: results.isEmpty
                ? Padding(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    child: Text(
                      _searchOffline
                          ? l10n.locationPickerSearchOffline
                          : l10n.locationPickerSearchEmpty,
                      key: ValueKey(
                        _searchOffline
                            ? 'location-search-offline'
                            : 'location-search-empty',
                      ),
                    ),
                  )
                : ListView(
                    key: const ValueKey('location-results'),
                    shrinkWrap: true,
                    children: [
                      for (final result in results)
                        ListTile(
                          leading: Icon(
                            result.source == 'barikoi'
                                ? Icons.place_outlined
                                : Icons.storefront_outlined,
                          ),
                          title: Text(
                            locale == 'bn'
                                ? (result.labelBn ?? result.label)
                                : result.label,
                          ),
                          subtitle: result.area == null
                              ? null
                              : Text(result.area!),
                          onTap: () => _pickResult(result, locale),
                        ),
                      if (results.any((r) => r.source == 'barikoi'))
                        const Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                            vertical: AppSpacing.xs,
                          ),
                          child: BarikoiAttribution(),
                        ),
                    ],
                  ),
          ),
        const SizedBox(height: AppSpacing.sm),
        Expanded(
          child: Stack(
            children: [
              BaseMap(
                initialCenter: LatLng(start.lat, start.lng),
                initialZoom: _initialZoom,
                onMapCreated: _onMapCreated,
                onCameraMove: (_) => _onCameraMoving(),
                onCameraIdle: (position) {
                  if (position == null) return;
                  _onCameraIdle((
                    lat: position.target.latitude,
                    lng: position.target.longitude,
                  ));
                },
              ),
              // The pin stays centred; its tip marks the point.
              IgnorePointer(
                child: Center(
                  child: Transform.translate(
                    offset: const Offset(0, -20),
                    child: Icon(
                      Icons.location_pin,
                      size: 44,
                      color: theme.colorScheme.error,
                      semanticLabel: l10n.locationPickerHint,
                    ),
                  ),
                ),
              ),
              Positioned(
                right: AppSpacing.md,
                bottom: AppSpacing.md,
                child: FloatingActionButton.small(
                  key: const ValueKey('location-my-location'),
                  heroTag: 'location-picker-my-location',
                  tooltip: l10n.locationPickerMyLocation,
                  onPressed: _useMyLocation,
                  child: const Icon(Icons.my_location),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(l10n.locationPickerHint, style: theme.textTheme.bodySmall),
              const SizedBox(height: AppSpacing.xs),
              if (_area case final area?)
                Row(
                  children: [
                    const Icon(Icons.map_outlined, size: 18),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        area,
                        key: const ValueKey('location-area'),
                        style: theme.textTheme.titleSmall,
                      ),
                    ),
                  ],
                ),
              const SizedBox(height: AppSpacing.xs),
              if (_point != null)
                AppTextField(
                  key: const ValueKey('location-address'),
                  label: _lookingUp
                      ? l10n.locationPickerLookingUp
                      : l10n.locationPickerAddressLabel,
                  controller: _addressText,
                  prefixIcon: Icons.edit_location_alt_outlined,
                  onChanged: (_) {
                    _edited = true;
                    _emit();
                  },
                ),
              if (_addressFromProvider && !_edited) const BarikoiAttribution(),
              if (_reverse?.degraded == true)
                Text(
                  l10n.locationPickerDegraded,
                  style: theme.textTheme.bodySmall,
                ),
              if (_notice case final notice?)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: Text(
                    notice,
                    key: const ValueKey('location-notice'),
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ?widget.below,
              if (widget.onConfirm case final onConfirm?)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: FilledButton(
                    key: const ValueKey('location-confirm'),
                    onPressed: _point == null
                        ? null
                        : () => onConfirm(_picked(_point!)),
                    child: Text(l10n.locationPickerConfirm),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
