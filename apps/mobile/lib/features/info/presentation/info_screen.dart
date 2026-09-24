import 'package:flutter/material.dart';

import '../../../core/design/widgets/empty_state.dart';
import '../../../l10n/app_localizations.dart';

/// Placeholder — no business features yet (Week 3 client-shell scope).
/// Emergency contacts are already cached locally (`EmergencyContactCache`)
/// once tenant bootstrap runs; this screen just doesn't read them yet.
/// `AppShell` provides the shared app bar/bottom nav; this is body content only.
class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return EmptyState(
      title: l10n.infoComingSoonTitle,
      icon: Icons.info_outline,
    );
  }
}
