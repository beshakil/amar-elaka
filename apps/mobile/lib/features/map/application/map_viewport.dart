import '../../../core/map/map_config_provider.dart';

/// When the Map tab offers "Search this area" instead of refetching on every
/// pan (ADR 046): the camera came to rest at another zoom level, or moved
/// more than [ratio] (`map_search_area_move_ratio`) of the fetched
/// viewport's width or height.
bool movedEnough({
  required LatLngBox fetched,
  required double fetchedZoom,
  required LatLngBox now,
  required double nowZoom,
  required double ratio,
}) {
  if (fetchedZoom.floor() != nowZoom.floor()) return true;
  final width = fetched.maxLng - fetched.minLng;
  final height = fetched.maxLat - fetched.minLat;
  final dx =
      ((now.minLng + now.maxLng) - (fetched.minLng + fetched.maxLng)) / 2;
  final dy =
      ((now.minLat + now.maxLat) - (fetched.minLat + fetched.maxLat)) / 2;
  return dx.abs() > width * ratio || dy.abs() > height * ratio;
}
