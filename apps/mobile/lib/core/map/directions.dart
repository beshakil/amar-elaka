import '../platform/external_apps.dart';

/// Directions hand-off (ADR 046): no turn-by-turn in the app. Google Maps
/// navigation when it is installed (`google.navigation:`), else Google Maps
/// on the web in the browser. Coordinates only — nothing about the user.
abstract final class Directions {
  static Uri app(double lat, double lng) =>
      Uri.parse('google.navigation:q=$lat,$lng');

  static Uri web(double lat, double lng) => Uri.https(
    'www.google.com',
    '/maps/dir/',
    {'api': '1', 'destination': '$lat,$lng'},
  );

  /// True when something opened.
  static Future<bool> open(ExternalApps apps, double lat, double lng) async {
    final app = Directions.app(lat, lng);
    if (await apps.canOpen(app) && await apps.open(app)) return true;
    return apps.open(web(lat, lng));
  }
}
