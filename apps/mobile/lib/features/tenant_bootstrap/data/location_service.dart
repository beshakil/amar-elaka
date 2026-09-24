import 'package:geolocator/geolocator.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'location_service.g.dart';

sealed class LocationResult {
  const LocationResult();
}

final class LocationGranted extends LocationResult {
  const LocationGranted(this.latitude, this.longitude);

  final double latitude;
  final double longitude;
}

/// Permission was refused (once — the caller can ask again later).
final class LocationDenied extends LocationResult {
  const LocationDenied();
}

/// Refused with "don't ask again" — only `Geolocator.openAppSettings()` can
/// change it now, not another in-app request.
final class LocationPermanentlyDenied extends LocationResult {
  const LocationPermanentlyDenied();
}

/// Permission is fine, but the device's location service itself is off.
final class LocationServiceDisabled extends LocationResult {
  const LocationServiceDisabled();
}

final class LocationError extends LocationResult {
  const LocationError();
}

/// Thin geolocator wrapper — no raw geolocator exceptions or platform
/// permission enums leak past this; callers only see [LocationResult].
class LocationService {
  Future<LocationResult> requestAndGetPosition() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return const LocationServiceDisabled();
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    switch (permission) {
      case LocationPermission.denied:
        return const LocationDenied();
      case LocationPermission.deniedForever:
        return const LocationPermanentlyDenied();
      case LocationPermission.whileInUse:
      case LocationPermission.always:
        break;
      case LocationPermission.unableToDetermine:
        return const LocationError();
    }

    try {
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.medium,
        ),
      );
      return LocationGranted(position.latitude, position.longitude);
    } catch (_) {
      return const LocationError();
    }
  }
}

@riverpod
LocationService locationService(Ref ref) => LocationService();
