import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../../../core/design/tokens/app_colors.dart';
import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_text_field.dart';
import '../../../../core/map/map_config.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../tenant_bootstrap/data/location_service.dart';
import '../../application/current_tenant.dart';
import '../../application/post_editor.dart';
import '../../data/posts_api.dart';
import 'step_gate.dart';

/// Map tiles on or off. Off in widget tests (no network) — the pin, address
/// lookup and boundary check work the same without them.
final mapTilesEnabledProvider = Provider<bool>((ref) => true);

/// Waits for the map to stop moving before asking the API about a point.
const _settleDelay = Duration(milliseconds: 600);
const _searchDelay = Duration(milliseconds: 400);
const _initialZoom = 16.0;

/// Step 4: where the post is. The map starts at the phone's location (else
/// the draft's point, else the area's centre); the pin stays in the middle
/// while the map moves under it. Each resting point is reverse-geocoded for
/// a readable address and checked against the area's boundary — outside it
/// is a warning, never a block (the server places the post in the right
/// area). Address search is the fallback when GPS or the map can't help.
class LocationStep extends ConsumerStatefulWidget {
  const LocationStep({required this.editor, required this.gate, super.key});

  final PostEditor editor;
  final StepGate gate;

  @override
  ConsumerState<LocationStep> createState() => _LocationStepState();
}

class _LocationStepState extends ConsumerState<LocationStep> {
  final _map = MapController();
  final _search = TextEditingController();
  Timer? _settle;
  Timer? _searchDebounce;
  int _lookup = 0;

  api.ReverseGeocode? _address;
  api.PostOwnership? _ownership;
  bool _lookingUp = false;
  String? _notice;
  List<api.GeocodeResult>? _results;
  bool _showRequired = false;

  @override
  void initState() {
    super.initState();
    widget.gate.register(_check);
    // After the first frame: the lookups read the locale and the messages.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final draft = widget.editor.draft!;
      if (draft.hasLocation) {
        _lookUp(LatLng(draft.lat!, draft.lng!));
      } else {
        unawaited(_useMyLocation(initial: true));
      }
    });
  }

  @override
  void dispose() {
    widget.gate.unregister(_check);
    _settle?.cancel();
    _searchDebounce?.cancel();
    _search.dispose();
    _map.dispose();
    super.dispose();
  }

  bool _check() {
    final ok = widget.editor.draft!.hasLocation;
    setState(() => _showRequired = !ok);
    return ok;
  }

  LatLng get _start {
    final draft = widget.editor.draft!;
    if (draft.hasLocation) return LatLng(draft.lat!, draft.lng!);
    final center = ref.read(currentTenantConfigProvider)?.mapCenter;
    // Bootstrapped apps always have a tenant; Dhaka only for a bare test/edge case.
    return center == null
        ? const LatLng(23.8103, 90.4125)
        : LatLng(center.lat, center.lng);
  }

  Future<void> _useMyLocation({bool initial = false}) async {
    final l10n = AppLocalizations.of(context)!;
    final result = await ref
        .read(locationServiceProvider)
        .requestAndGetPosition();
    if (!mounted) return;
    switch (result) {
      case LocationGranted(:final latitude, :final longitude):
        _moveTo(LatLng(latitude, longitude));
      case LocationDenied() || LocationPermanentlyDenied():
        setState(() => _notice = l10n.postLocationPermissionDenied);
        if (initial) _moveTo(_start);
      case LocationServiceDisabled():
        setState(() => _notice = l10n.postLocationServiceOff);
        if (initial) _moveTo(_start);
      case LocationError():
        if (initial) _moveTo(_start);
    }
  }

  void _moveTo(LatLng point) {
    try {
      _map.move(point, _initialZoom);
    } on StateError {
      // The map isn't laid out yet (first frame): it opens at [_start].
    }
    _lookUp(point);
  }

  void _onMapMoved(MapCamera camera, bool hasGesture) {
    if (!hasGesture) return;
    _settle?.cancel();
    _settle = Timer(_settleDelay, () => _lookUp(camera.center));
  }

  /// Saves the point, then fetches its address and ownership — the latest
  /// request wins; answers for points the user already left are dropped.
  Future<void> _lookUp(LatLng point) async {
    widget.editor.update(
      (d) => d.copyWith(lat: point.latitude, lng: point.longitude),
    );
    final requestId = ++_lookup;
    setState(() {
      _lookingUp = true;
      _showRequired = false;
    });
    final posts = ref.read(postsApiProvider);
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    try {
      final (address, ownership) = await (
        posts.reverseGeocode(point.latitude, point.longitude),
        posts.ownership(point.latitude, point.longitude),
      ).wait;
      if (!mounted || requestId != _lookup) return;
      final label = _label(address, locale);
      widget.editor.update((d) => d.copyWith(addressLabel: label));
      setState(() {
        _address = address;
        _ownership = ownership;
        _lookingUp = false;
      });
    } on ParallelWaitError<
      (api.ReverseGeocode?, api.PostOwnership?),
      (AsyncError?, AsyncError?)
    > catch (e) {
      if (!mounted || requestId != _lookup) return;
      // Either lookup may fail on its own (offline, provider down): keep
      // whatever came back; the point itself is already saved.
      setState(() {
        _address = e.values.$1;
        _ownership = e.values.$2;
        _lookingUp = false;
        if (e.errors.$1?.error is NetworkException) {
          _notice = l10n.postErrorNetwork;
        }
      });
    }
  }

  /// The provider's address in the reader's script, else our own area names
  /// (union, upazila, district), else nothing.
  static String? _label(api.ReverseGeocode geo, String locale) {
    final address = geo.address;
    if (address != null) {
      return locale == 'bn'
          ? (address.labelBn ?? address.label)
          : address.label;
    }
    final areas = geo.areas.reversed
        .where((a) => a.level != 'country' && a.level != 'division')
        .take(3)
        .map((a) => a.name.of(locale));
    return areas.isEmpty ? null : areas.join(', ');
  }

  void _onSearchChanged(String query) {
    _searchDebounce?.cancel();
    if (query.trim().isEmpty) {
      setState(() => _results = null);
      return;
    }
    _searchDebounce = Timer(_searchDelay, () async {
      final draft = widget.editor.draft!;
      try {
        final response = await ref
            .read(postsApiProvider)
            .autocomplete(query.trim(), lat: draft.lat, lng: draft.lng);
        if (mounted && _search.text.trim() == query.trim()) {
          setState(() => _results = response.results);
        }
      } on AppException {
        if (mounted) setState(() => _results = const []);
      }
    });
  }

  void _pickResult(api.GeocodeResult result) {
    FocusScope.of(context).unfocus();
    _search.clear();
    setState(() => _results = null);
    _moveTo(LatLng(result.location.lat, result.location.lng));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final tilesOn = ref.watch(mapTilesEnabledProvider);
    final tenantName = ref.watch(currentTenantConfigProvider)?.nameBn ?? '';
    final draft = widget.editor.draft!;
    final warningColors = theme.brightness == Brightness.dark
        ? AppColors.dark
        : AppColors.light;

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
            label: l10n.postLocationSearchHint,
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
                    child: Text(l10n.postLocationSearchEmpty),
                  )
                : ListView(
                    shrinkWrap: true,
                    children: [
                      for (final result in results)
                        ListTile(
                          leading: const Icon(Icons.place_outlined),
                          title: Text(result.labelBn ?? result.label),
                          subtitle: result.area == null
                              ? null
                              : Text(result.area!),
                          onTap: () => _pickResult(result),
                        ),
                    ],
                  ),
          ),
        const SizedBox(height: AppSpacing.sm),
        Expanded(
          child: Stack(
            children: [
              FlutterMap(
                mapController: _map,
                options: MapOptions(
                  initialCenter: _start,
                  initialZoom: _initialZoom,
                  maxZoom: MapConfig.maxZoom.toDouble(),
                  onPositionChanged: _onMapMoved,
                  interactionOptions: const InteractionOptions(
                    flags:
                        InteractiveFlag.drag |
                        InteractiveFlag.pinchZoom |
                        InteractiveFlag.doubleTapZoom,
                  ),
                ),
                children: [
                  if (tilesOn)
                    TileLayer(
                      urlTemplate: MapConfig.tileUrl,
                      userAgentPackageName: MapConfig.userAgentPackageName,
                      maxNativeZoom: MapConfig.maxZoom,
                      // Fewer tiles held in memory: this runs on 2 GB phones.
                      keepBuffer: 1,
                      panBuffer: 0,
                    ),
                  if (tilesOn)
                    SimpleAttributionWidget(
                      source: const Text(MapConfig.attribution),
                    ),
                ],
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
                      semanticLabel: l10n.postLocationHint,
                    ),
                  ),
                ),
              ),
              Positioned(
                right: AppSpacing.md,
                bottom: AppSpacing.md,
                child: FloatingActionButton.small(
                  heroTag: 'my-location',
                  tooltip: l10n.postLocationMyLocation,
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
              Text(l10n.postLocationHint, style: theme.textTheme.bodySmall),
              const SizedBox(height: AppSpacing.xs),
              if (_lookingUp)
                Text(
                  l10n.postLocationLookingUp,
                  style: theme.textTheme.bodyMedium,
                )
              else if (draft.addressLabel case final label?)
                Row(
                  children: [
                    const Icon(Icons.place_outlined, size: 18),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        label,
                        key: const ValueKey('location-address'),
                        style: theme.textTheme.titleSmall,
                      ),
                    ),
                  ],
                )
              else if (draft.hasLocation)
                Text(
                  l10n.postLocationUnknownAddress,
                  style: theme.textTheme.bodySmall,
                ),
              if (_address?.degraded == true)
                Text(
                  l10n.postLocationDegraded,
                  style: theme.textTheme.bodySmall,
                ),
              if (_ownership case final ownership?
                  when ownership.outsideBoundary)
                Container(
                  key: const ValueKey('location-outside-warning'),
                  margin: const EdgeInsets.only(top: AppSpacing.sm),
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  decoration: BoxDecoration(
                    color: warningColors.warning.withValues(alpha: 0.15),
                    borderRadius: AppRadii.mdRadius,
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.warning_amber_rounded,
                        color: warningColors.warning,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Text(
                          [
                            l10n.postLocationOutsideWarning(tenantName),
                            if (ownership.needsReview)
                              l10n.postLocationNeedsReview,
                          ].join(' '),
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    ],
                  ),
                ),
              if (_notice case final notice?)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: Text(notice, style: theme.textTheme.bodySmall),
                ),
              if (_showRequired)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: Text(
                    l10n.postLocationRequired,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
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
