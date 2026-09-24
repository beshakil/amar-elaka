import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/widgets/empty_state.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';

/// Placeholder — no business features yet (Week 3 client-shell scope).
/// Posting is guest-gated (docs/decisions/020-mobile-auth-tenant-bootstrap-flows.md):
/// the action only appears for guests, to demonstrate `requireLogin` — an
/// authenticated user has nothing to tap into yet either, since posting
/// itself isn't built. `AppShell` provides the shared app bar/bottom nav;
/// this is body content only.
class PostScreen extends ConsumerWidget {
  const PostScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final isGuest =
        ref.watch(authControllerProvider) is! AuthSessionAuthenticated;

    return EmptyState(
      title: l10n.postComingSoonTitle,
      icon: Icons.add_box_outlined,
      actionLabel: isGuest ? l10n.postLoginRequiredMessage : null,
      onAction: isGuest ? () => requireLogin(context, ref) : null,
    );
  }
}
