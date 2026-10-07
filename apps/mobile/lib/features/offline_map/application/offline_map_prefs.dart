import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The user's two choices about the downloaded map (ADR 050).
class OfflineMapPrefs {
  const OfflineMapPrefs({
    this.autoUpdateOnWifi = true,
    this.useDownloadedMap = true,
  });

  /// Download a newer version by itself, on Wi-Fi only.
  final bool autoUpdateOnWifi;

  /// Draw the map from the downloaded file even when online (saves data).
  /// Off: the downloaded file is used only without a connection.
  final bool useDownloadedMap;

  OfflineMapPrefs copyWith({bool? autoUpdateOnWifi, bool? useDownloadedMap}) =>
      OfflineMapPrefs(
        autoUpdateOnWifi: autoUpdateOnWifi ?? this.autoUpdateOnWifi,
        useDownloadedMap: useDownloadedMap ?? this.useDownloadedMap,
      );
}

class OfflineMapPrefsNotifier extends AsyncNotifier<OfflineMapPrefs> {
  static const _autoKey = 'offline_map.auto_update_wifi';
  static const _useKey = 'offline_map.use_downloaded';

  @override
  Future<OfflineMapPrefs> build() async {
    final prefs = await SharedPreferences.getInstance();
    return OfflineMapPrefs(
      autoUpdateOnWifi: prefs.getBool(_autoKey) ?? true,
      useDownloadedMap: prefs.getBool(_useKey) ?? true,
    );
  }

  Future<void> setAutoUpdateOnWifi(bool value) async {
    await (await SharedPreferences.getInstance()).setBool(_autoKey, value);
    state = AsyncData(
      (state.value ?? const OfflineMapPrefs()).copyWith(
        autoUpdateOnWifi: value,
      ),
    );
  }

  Future<void> setUseDownloadedMap(bool value) async {
    await (await SharedPreferences.getInstance()).setBool(_useKey, value);
    state = AsyncData(
      (state.value ?? const OfflineMapPrefs()).copyWith(
        useDownloadedMap: value,
      ),
    );
  }
}

final offlineMapPrefsProvider =
    AsyncNotifierProvider<OfflineMapPrefsNotifier, OfflineMapPrefs>(
      OfflineMapPrefsNotifier.new,
    );

/// Whether the phone is on Wi-Fi (or Ethernet) now: auto-updates wait for it.
abstract interface class WifiCheck {
  Future<bool> onWifi();
}

class ConnectivityWifiCheck implements WifiCheck {
  @override
  Future<bool> onWifi() async {
    final results = await Connectivity().checkConnectivity();
    return results.contains(ConnectivityResult.wifi) ||
        results.contains(ConnectivityResult.ethernet);
  }
}

final wifiCheckProvider = Provider<WifiCheck>((ref) => ConnectivityWifiCheck());
