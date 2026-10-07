import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/map/location_picker.dart' show GeoPoint;
import '../../../core/map/map_config_provider.dart';
import '../../../l10n/app_localizations.dart';
import '../../map/presentation/map_preview_sheet.dart' show formatDistance;
import '../../offline_map/domain/offline_points.dart' show haversineMeters;
import '../data/place_feedback_api.dart';
import 'place_feedback_messages.dart';

/// How far around the place to look for its twin: about 500 m each way
/// (the server refuses past duplicate_report_radius_m anyway).
const _twinSearchDegrees = 0.005;

/// Past the clustering zoom, so every place comes back as itself.
const _twinSearchZoom = 20.0;

/// The nearest few are enough to choose from.
const _twinsShown = 8;

/// What the member chose in the sheet.
typedef PlaceReport = ({String reason, String text, String? duplicateOf});

/// "সমস্যা জানান" for a place: a reason, optionally a few words, and with
/// "listed twice" which nearby place is the same one (ADR 051).
abstract final class PlaceReportSheet {
  static Future<PlaceReport?> show(
    BuildContext context, {
    required String placeId,
    required GeoPoint location,
  }) => AppBottomSheet.show<PlaceReport>(
    context,
    isScrollControlled: true,
    builder: (_) => _PlaceReportBody(placeId: placeId, location: location),
  );
}

class _PlaceReportBody extends ConsumerStatefulWidget {
  const _PlaceReportBody({required this.placeId, required this.location});

  final String placeId;
  final GeoPoint location;

  @override
  ConsumerState<_PlaceReportBody> createState() => _PlaceReportBodyState();
}

class _PlaceReportBodyState extends ConsumerState<_PlaceReportBody> {
  String? _reason;
  String? _twin;
  Future<List<({api.MapFeature place, double meters})>>? _twins;
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  /// Places around this one, nearest first (once, when "listed twice" is picked).
  Future<List<({api.MapFeature place, double meters})>> _loadTwins() async {
    final at = widget.location;
    final features = await ref
        .read(mapApiProvider)
        .features(
          bbox: (
            minLng: at.lng - _twinSearchDegrees,
            minLat: at.lat - _twinSearchDegrees,
            maxLng: at.lng + _twinSearchDegrees,
            maxLat: at.lat + _twinSearchDegrees,
          ),
          zoom: _twinSearchZoom,
          layers: const {'places'},
        );
    final near = [
      for (final f in features.features)
        if (!f.isCluster &&
            f.properties.id != null &&
            f.properties.id != widget.placeId)
          (place: f, meters: haversineMeters(at.lat, at.lng, f.lat, f.lng)),
    ]..sort((a, b) => a.meters.compareTo(b.meters));
    return near.take(math.min(_twinsShown, near.length)).toList();
  }

  void _pickReason(String? value) => setState(() {
    _reason = value;
    if (value == 'duplicate') {
      _twins ??= _loadTwins();
    } else {
      _twin = null;
    }
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          key: const ValueKey('place-report-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.placeReportTitle,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            RadioGroup<String>(
              groupValue: _reason,
              onChanged: _pickReason,
              child: Column(
                children: [
                  for (final code in placeReportReasons)
                    RadioListTile<String>(
                      key: ValueKey('place-report-$code'),
                      value: code,
                      title: Text(placeReportReasonLabel(code, l10n)),
                      contentPadding: EdgeInsets.zero,
                    ),
                ],
              ),
            ),
            if (_reason == 'duplicate')
              FutureBuilder(
                future: _twins,
                builder: (context, snapshot) {
                  final twins = snapshot.data;
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const LinearProgressIndicator();
                  }
                  if (twins == null || twins.isEmpty) {
                    return Text(
                      l10n.placeReportNoTwins,
                      key: const ValueKey('place-report-no-twins'),
                      style: Theme.of(context).textTheme.bodySmall,
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        l10n.placeReportWhichTwin,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      RadioGroup<String?>(
                        groupValue: _twin,
                        onChanged: (value) => setState(() => _twin = value),
                        child: Column(
                          children: [
                            for (final t in twins)
                              RadioListTile<String?>(
                                key: ValueKey(
                                  'place-report-twin-${t.place.properties.id}',
                                ),
                                value: t.place.properties.id,
                                title: Text(
                                  t.place.properties.nameBn ??
                                      t.place.properties.nameEn ??
                                      l10n.mapUnnamed,
                                ),
                                subtitle: Text(
                                  formatDistance(l10n, t.meters, locale),
                                ),
                                contentPadding: EdgeInsets.zero,
                              ),
                            RadioListTile<String?>(
                              key: const ValueKey('place-report-twin-none'),
                              value: null,
                              title: Text(l10n.placeReportTwinUnsure),
                              contentPadding: EdgeInsets.zero,
                            ),
                          ],
                        ),
                      ),
                    ],
                  );
                },
              ),
            TextField(
              key: const ValueKey('place-report-text'),
              controller: _text,
              maxLines: 3,
              decoration: InputDecoration(labelText: l10n.placeReportDetails),
            ),
            const SizedBox(height: AppSpacing.md),
            AppButton(
              key: const ValueKey('place-report-send'),
              label: l10n.placeReportSend,
              onPressed: _reason == null
                  ? null
                  : () => Navigator.of(context).pop((
                      reason: _reason!,
                      text: _text.text,
                      duplicateOf: _twin,
                    )),
            ),
          ],
        ),
      ),
    );
  }
}
