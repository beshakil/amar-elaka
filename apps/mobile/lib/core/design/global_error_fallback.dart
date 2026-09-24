import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'widgets/error_state.dart';

/// `ErrorWidget.builder`'s replacement (wired once in `main.dart`) — a
/// widget build failing anywhere in the tree renders this instead of
/// Flutter's default red error box, so a bug never shows the user a raw
/// exception. Built in place of whatever failed, so it usually still has a
/// real `Localizations` ancestor; the plain-English fallback only fires in
/// the practically-unreachable case where it doesn't (e.g. failing before
/// `MaterialApp` itself has mounted).
class GlobalErrorFallback extends StatelessWidget {
  const GlobalErrorFallback({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Material(
      child: SafeArea(
        child: ErrorState(
          title: l10n?.errorGenericTitle ?? 'Something went wrong',
          message: l10n?.errorGenericMessage,
        ),
      ),
    );
  }
}
