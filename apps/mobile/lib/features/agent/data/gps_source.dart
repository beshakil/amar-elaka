import 'package:geolocator/geolocator.dart';

/// One GPS fix: where, how sure (metres), when.
class GpsFix {
  const GpsFix({
    required this.lat,
    required this.lng,
    required this.accuracyM,
    required this.at,
  });

  final double lat;
  final double lng;
  final double accuracyM;
  final DateTime at;
}

/// The phone's GPS as a stream of fixes (injectable: tests feed their own).
abstract interface class GpsSource {
  /// Asks for permission when needed; false = no location available.
  Future<bool> ensureAllowed();
  Stream<GpsFix> fixes();
}

class GeolocatorGpsSource implements GpsSource {
  const GeolocatorGpsSource();

  @override
  Future<bool> ensureAllowed() async {
    if (!await Geolocator.isLocationServiceEnabled()) return false;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission == LocationPermission.whileInUse ||
        permission == LocationPermission.always;
  }

  @override
  Stream<GpsFix> fixes() =>
      Geolocator.getPositionStream(
        // Best accuracy, every update: the agent waits for a tight fix in front of the shop.
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.bestForNavigation,
          distanceFilter: 0,
        ),
      ).map(
        (p) => GpsFix(
          lat: p.latitude,
          lng: p.longitude,
          accuracyM: p.accuracy,
          at: p.timestamp,
        ),
      );
}
