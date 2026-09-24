import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'session_signal.g.dart';

/// Fires when [RefreshInterceptor] gives up on a session (refresh token
/// missing/rejected). Deliberately not part of the auth feature: the
/// network layer can't depend on `features/auth` without a cycle (auth
/// repositories depend on the Dio client), so this is the decoupling point
/// — `AuthController` and the router's redirect logic both watch it.
@riverpod
class SessionSignal extends _$SessionSignal {
  @override
  int build() => 0;

  void notifyExpired() => state++;
}
