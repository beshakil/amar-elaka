import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';

/// Credit shown wherever a Barikoi search or address result is displayed
/// (ADR 043). PLACEHOLDER WORDING (`mapBarikoiAttribution`): to be confirmed
/// against Barikoi's terms before launch. Only for results whose `source` is
/// the provider, never for our own area data.
class BarikoiAttribution extends StatelessWidget {
  const BarikoiAttribution({super.key});

  @override
  Widget build(BuildContext context) => Text(
    AppLocalizations.of(context)!.mapBarikoiAttribution,
    key: const ValueKey('barikoi-attribution'),
    style: Theme.of(context).textTheme.labelSmall,
  );
}
