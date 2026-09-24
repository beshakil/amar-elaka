import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'connectivity_provider.g.dart';

/// `true` once there's *some* connectivity (WiFi/mobile/ethernet/etc.) —
/// doesn't guarantee `apps/api` is actually reachable, just enough to drive
/// the offline banner. Individual requests still time out and get mapped to
/// `NetworkException`/`TimeoutException` on their own regardless of this.
@riverpod
Stream<bool> isOnline(Ref ref) async* {
  final connectivity = Connectivity();
  // `onConnectivityChanged` only emits on *changes* — checking once up front
  // means the offline banner has a real answer immediately instead of
  // reading as "online" (the initial `AsyncLoading` default) until the
  // first change happens to occur.
  yield _hasConnection(await connectivity.checkConnectivity());
  yield* connectivity.onConnectivityChanged.map(_hasConnection);
}

bool _hasConnection(List<ConnectivityResult> results) {
  return results.any((result) => result != ConnectivityResult.none);
}
