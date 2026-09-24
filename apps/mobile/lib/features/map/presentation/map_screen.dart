import 'package:flutter/material.dart';

import '../../../core/design/widgets/empty_state.dart';
import '../../../l10n/app_localizations.dart';

/// Placeholder — no business features yet (Week 3 client-shell scope).
/// `AppShell` provides the shared app bar/bottom nav; this is body content only.
class MapScreen extends StatelessWidget {
  const MapScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return EmptyState(title: l10n.mapComingSoonTitle, icon: Icons.map_outlined);
  }
}
