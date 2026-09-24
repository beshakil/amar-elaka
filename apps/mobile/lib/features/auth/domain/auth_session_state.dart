import 'package:amar_elaka_api/amar_elaka_api.dart';

/// Whether we know who the caller is yet, and who they are if so. Loading a
/// session doesn't go through `AsyncValue` here (unlike tenant bootstrap):
/// `AuthController` needs a stable synchronous "unknown" state while it
/// checks storage/calls `/auth/me`, because the router's redirect logic
/// reads it on every navigation, not just once.
sealed class AuthSessionState {
  const AuthSessionState();
}

/// Still checking stored tokens / hasn't resolved yet.
final class AuthSessionUnknown extends AuthSessionState {
  const AuthSessionUnknown();
}

final class AuthSessionAuthenticated extends AuthSessionState {
  const AuthSessionAuthenticated(this.me);

  final MeResult me;
}

final class AuthSessionUnauthenticated extends AuthSessionState {
  const AuthSessionUnauthenticated();
}
