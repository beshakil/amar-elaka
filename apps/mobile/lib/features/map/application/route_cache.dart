import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/map/map_config_provider.dart';

/// "রাস্তায় কত দূর?" (ADR 046): one POST /geo/route per destination and
/// mode for the whole session — a road route is a paid Barikoi call, asked
/// for only by the button, and asking again (reopening the sheet) is free.
class RouteCache {
  RouteCache(this._api);

  final MapApi _api;
  final _answers = <String, Future<RouteAnswer>>{};

  static String key(String featureId, String mode) => '$mode:$featureId';

  /// The cached answer for [featureId], if any (no request).
  Future<RouteAnswer>? cached(String featureId, String mode) =>
      _answers[key(featureId, mode)];

  /// The road from the user to the feature; a failure is not cached, so the
  /// user can try again.
  Future<RouteAnswer> route({
    required String featureId,
    required String mode,
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  }) {
    final k = key(featureId, mode);
    return _answers[k] ??= _api
        .route(
          fromLat: fromLat,
          fromLng: fromLng,
          toLat: toLat,
          toLng: toLng,
          mode: mode,
        )
        .catchError((Object error) {
          _answers.remove(k);
          throw error;
        });
  }
}

/// Lives as long as the app process: "the session".
final routeCacheProvider = Provider<RouteCache>(
  (ref) => RouteCache(ref.watch(mapApiProvider)),
);
