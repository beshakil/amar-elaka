/// Base URL for `apps/api`. Override per environment with
/// `flutter run --dart-define=API_BASE_URL=https://staging.amarelaka.local/api/v1`.
///
/// The default targets the Android emulator's host-loopback alias
/// (`10.0.2.2` reaches the host machine's `localhost` from inside the AVD),
/// matching `apps/api`'s `/api` prefix + URI version 1
/// (`setGlobalPrefix('api', ...)` + `enableVersioning(...)` in
/// apps/api/src/main.ts) against the default dev `PORT=3000`.
abstract final class ApiConfig {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );
}
