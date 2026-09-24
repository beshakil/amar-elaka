import 'package:amar_elaka_api/amar_elaka_api.dart';

/// `POST /auth/google` returns a different shape depending on whether the
/// caller was authenticated (link) or not (sign in) —
/// `AuthService.googleAuth`'s dual-mode comment on the backend.
sealed class GoogleAuthResult {
  const GoogleAuthResult();
}

final class GoogleSignedIn extends GoogleAuthResult {
  const GoogleSignedIn(this.tokens);

  final SessionTokens tokens;
}

final class GoogleLinked extends GoogleAuthResult {
  const GoogleLinked();
}
