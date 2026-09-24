import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/domain/auth_session_state.dart';
import 'route_paths.dart';

/// Gate for actions guests can't do (posting, chat, saving —
/// docs/decisions/020-mobile-auth-tenant-bootstrap-flows.md). Already
/// authenticated → returns `true` and the caller proceeds. Guest → sent to
/// sign in and the action simply doesn't happen this time; returning to
/// exactly where the user was after a successful login isn't implemented
/// yet (noted as a follow-up, not silently half-built) — they land on the
/// home tab like any other freshly-authenticated session.
bool requireLogin(BuildContext context, WidgetRef ref) {
  if (ref.read(authControllerProvider) case AuthSessionAuthenticated()) {
    return true;
  }
  context.push(RoutePaths.login);
  return false;
}
