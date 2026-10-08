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
          // Without a limit this waits for ever when no fresh fix comes
          // (indoors, an emulator): the screen just spun (found on a device).
          timeLimit: locationFixTimeLimit,
        ),
      );
      return LocationGranted(position.latitude, position.longitude);
    } catch (_) {
      // No fresh fix in time: the phone's last known position finds the
      // area just as well (an area is kilometres wide).
      try {
        final last = await Geolocator.getLastKnownPosition();
        if (last != null) return LocationGranted(last.latitude, last.longitude);
      } catch (_) {
        // Fall through.
      }
      return const LocationError();
    }
  }
}

/// How long the area finder waits for a fresh location before using the last
/// known one. Before an area is picked there is no tenant config to read a
/// setting from, so this one lives here.
const locationFixTimeLimit = Duration(seconds: 15);

/// The phone's position only if location is already allowed and on — never
/// asks (the bootstrap flow owns the rationale and the prompt). Null
/// otherwise: callers fall back to the area's centre.
extension QuietPosition on LocationService {
  Future<LocationGranted?> positionIfAllowed() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return null;
      final permission = await Geolocator.checkPermission();
      if (permission != LocationPermission.whileInUse &&
          permission != LocationPermission.always) {
        return null;
      }
      final position =
          await Geolocator.getLastKnownPosition() ??
          await Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.medium,
              timeLimit: locationFixTimeLimit,
            ),
          );
      return LocationGranted(position.latitude, position.longitude);
    } catch (_) {
      return null;
    }
  }
}

@riverpod
LocationService locationService(Ref ref) => LocationService();
