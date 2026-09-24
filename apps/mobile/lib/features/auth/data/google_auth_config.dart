/// Not set yet — real Google sign-in needs an Android OAuth client (tied to
/// `com.amarelaka.app`'s release/debug SHA-1 fingerprints, registered in
/// Google Cloud Console) for [clientId], and a separate *Web* OAuth client
/// for [serverClientId] (required for `idToken` to come back on Android at
/// all — see docs/decisions/020-mobile-auth-tenant-bootstrap-flows.md).
/// Both are compiled in via `--dart-define`, matching `ApiConfig.baseUrl`'s
/// pattern; empty until those exist.
abstract final class GoogleAuthConfig {
  static const String clientId = String.fromEnvironment(
    'GOOGLE_OAUTH_CLIENT_ID',
  );
  static const String serverClientId = String.fromEnvironment(
    'GOOGLE_OAUTH_SERVER_CLIENT_ID',
  );
}
