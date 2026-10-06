import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/barikoi_attribution.dart';
import '../../../core/map/map_pin_images.dart';
import '../../../l10n/app_localizations.dart';

const _metersPerKm = 1000;
const _secondsPerMinute = 60;
const _photoHeight = 140.0;

/// "1.2 কিমি" / "850 মিটার" in the reader's digits.
String formatDistance(AppLocalizations l10n, double meters, String locale) {
  if (meters >= _metersPerKm) {
    final km = (meters / _metersPerKm)
        .toStringAsFixed(1)
        .replaceFirst(RegExp(r'\.0$'), '');
    return l10n.mapKm(localizeDigits(km, locale));
  }
  return l10n.mapMeters(localizeDigits('${meters.round()}', locale));
}

/// The road answer as the sheet shows it.
sealed class RoadState {
  const RoadState();
}

final class RoadIdle extends RoadState {
  const RoadIdle();
}

final class RoadLoading extends RoadState {
  const RoadLoading();
}

final class RoadAnswered extends RoadState {
  const RoadAnswered(this.answer);
  final api.RouteAnswer answer;
}

final class RoadFailed extends RoadState {
  const RoadFailed(this.message);
  final String message;
}

/// The Map tab's preview of a tapped pin (ADR 046): photo, the name in
/// Bengali as Flutter shapes it (never map text), kind, open/closed, the
/// straight-line distance (free), address, and three actions — call,
/// directions (hand-off to Google Maps) and "রাস্তায় কত দূর?" (one paid
/// route per session). Pure presentation: the screen owns the requests.
class MapPreviewSheet extends StatelessWidget {
  const MapPreviewSheet({
    required this.feature,
    required this.kind,
    required this.preview,
    required this.loading,
    required this.failed,
    required this.straightMeters,
    required this.road,
    required this.onRoad,
    required this.onDirections,
    required this.onCall,
    super.key,
  });

  final api.MapFeature feature;

  /// The feature's `map_kinds` entry, when it has one.
  final api.MapKind? kind;
  final api.MapPreview? preview;
  final bool loading;
  final bool failed;

  /// From the user to the feature (GET /map/distance); null when the user's
  /// location is unknown.
  final double? straightMeters;
  final RoadState road;

  /// Null when the user's location is unknown (no "from" for a route).
  final VoidCallback? onRoad;
  final VoidCallback onDirections;

  /// Null when there is no way to call (no public number, not a post).
  final VoidCallback? onCall;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final props = feature.properties;
    final name =
        props.nameBn ??
        preview?.name.bn ??
        props.nameEn ??
        preview?.name.en ??
        l10n.mapUnnamed;
    final photo = preview?.photo;
    final kindLabel = kind == null
        ? null
        : (locale == 'bn' ? kind!.label.bn : kind!.label.en);

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          0,
          AppSpacing.md,
          AppSpacing.md,
        ),
        child: Column(
          key: const ValueKey('map-preview'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (photo != null)
              ClipRRect(
                borderRadius: AppRadii.mdRadius,
                child: SizedBox(
                  height: _photoHeight,
                  child: NetworkPhoto(
                    url: photo.url,
                    thumbhash: photo.thumbhash,
                    decodeWidth: MediaQuery.sizeOf(context).width,
                  ),
                ),
              ),
            if (photo != null) const SizedBox(height: AppSpacing.sm),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(
                  radius: 18,
                  backgroundColor: MapPinImages.colourFor(kind?.icon),
                  child: Icon(
                    MapPinImages.iconFor(kind?.icon),
                    size: 20,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        key: const ValueKey('map-preview-name'),
                        style: theme.textTheme.titleMedium,
                      ),
                      Wrap(
                        spacing: AppSpacing.sm,
                        children: [
                          Text(
                            kindLabel ?? l10n.mapKindOther,
                            style: theme.textTheme.bodySmall,
                          ),
                          if (props.openNow case final open?)
                            Text(
                              open ? l10n.mapIsOpen : l10n.mapIsClosed,
                              key: const ValueKey('map-preview-open'),
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: open
                                    ? Colors.green.shade700
                                    : theme.colorScheme.error,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                        ],
                      ),
                      if (props.price case final price?)
                        Text(
                          '৳ ${formatMoney(price, locale)}',
                          style: theme.textTheme.bodyMedium,
                        ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            if (straightMeters case final meters?)
              Text(
                l10n.mapPreviewStraight(formatDistance(l10n, meters, locale)),
                key: const ValueKey('map-preview-distance'),
                style: theme.textTheme.bodyMedium,
              ),
            if (preview?.address case final address?)
              Text(address, style: theme.textTheme.bodySmall),
            if (loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.xs),
                child: LinearProgressIndicator(),
              ),
            if (failed)
              Text(l10n.mapPreviewLoadFailed, style: theme.textTheme.bodySmall),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              children: [
                if (onCall != null)
                  FilledButton.icon(
                    key: const ValueKey('map-preview-call'),
                    icon: const Icon(Icons.call),
                    label: Text(l10n.mapPreviewCall),
                    onPressed: onCall,
                  ),
                OutlinedButton.icon(
                  key: const ValueKey('map-preview-directions'),
                  icon: const Icon(Icons.directions),
                  label: Text(l10n.mapPreviewDirections),
                  onPressed: onDirections,
                ),
                if (onRoad != null)
                  OutlinedButton.icon(
                    key: const ValueKey('map-preview-road'),
                    icon: const Icon(Icons.alt_route),
                    label: Text(l10n.mapPreviewRoadDistance),
                    onPressed: road is RoadLoading ? null : onRoad,
                  ),
              ],
            ),
            switch (road) {
              RoadIdle() => const SizedBox.shrink(),
              RoadLoading() => Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text(l10n.mapRouting),
              ),
              RoadFailed(:final message) => Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text(message, style: theme.textTheme.bodySmall),
              ),
              RoadAnswered(:final answer) => Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      key: const ValueKey('map-preview-route'),
                      answer.durationSeconds == null
                          ? l10n.mapRouteStraight(
                              formatDistance(
                                l10n,
                                answer.distanceMeters,
                                locale,
                              ),
                            )
                          : l10n.mapRouteResult(
                              formatDistance(
                                l10n,
                                answer.distanceMeters,
                                locale,
                              ),
                              localizeDigits(
                                '${math.max(1, (answer.durationSeconds! / _secondsPerMinute).round())}',
                                locale,
                              ),
                            ),
                      style: theme.textTheme.titleSmall,
                    ),
                    if (answer.source == 'barikoi') const BarikoiAttribution(),
                  ],
                ),
              ),
            },
          ],
        ),
      ),
    );
  }
}
