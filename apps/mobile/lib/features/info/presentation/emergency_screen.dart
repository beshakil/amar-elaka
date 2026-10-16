import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/platform/external_apps.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/presentation/listing_format.dart';
import '../application/info_providers.dart';
import '../data/emergency_repository.dart';
import '../data/info_models.dart';
import 'info_labels.dart';

/// The emergency page (ADR 064): national helplines, then the local
/// contacts near the area grouped by type — one tap calls, a pin opens the
/// phone's map. It never shows an error or a spinner over nothing: the kept
/// copy (or the numbers shipped in the app) shows first.
class EmergencyScreen extends ConsumerWidget {
  const EmergencyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final snapshot = ref.watch(emergencyControllerProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.infoHubEmergencyTitle)),
      body: snapshot == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () =>
                  ref.read(emergencyControllerProvider.notifier).refresh(),
              child: ListView(
                padding: const EdgeInsets.all(AppSpacing.md),
                children: [
                  if (snapshot.source != EmergencySource.live)
                    _SourceNote(snapshot: snapshot, locale: locale),
                  _SectionTitle(l10n.emergencyNationalTitle),
                  for (final h in snapshot.page.national)
                    _CallTile(
                      title: h.name.of(locale) ?? h.dial,
                      subtitle: h.description.of(locale),
                      phones: [h.dial],
                      emphasise: h.serviceType == 'national_emergency',
                    ),
                  const SizedBox(height: AppSpacing.md),
                  _SectionTitle(l10n.emergencyLocalTitle),
                  if (snapshot.page.groups.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: Text(l10n.emergencyNoLocal),
                    ),
                  for (final group in snapshot.page.groups) ...[
                    Padding(
                      padding: const EdgeInsets.only(
                        top: AppSpacing.sm,
                        bottom: AppSpacing.xs,
                      ),
                      child: Text(
                        InfoLabels.serviceType(group.serviceType, l10n),
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    for (final c in group.contacts) _LocalTile(contact: c),
                  ],
                ],
              ),
            ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
    child: Text(text, style: Theme.of(context).textTheme.titleMedium),
  );
}

class _SourceNote extends StatelessWidget {
  const _SourceNote({required this.snapshot, required this.locale});

  final EmergencySnapshot snapshot;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final at = snapshot.fetchedAt;
    final text = snapshot.source == EmergencySource.bundled || at == null
        ? l10n.emergencyBundledNote
        : l10n.emergencyCachedNote(InfoLabels.moment(at, locale));
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppSpacing.sm),
      ),
      child: Row(
        children: [
          const Icon(Icons.cloud_off, size: 18),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}

class _LocalTile extends ConsumerWidget {
  const _LocalTile({required this.contact});

  final LocalEmergencyContact contact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final details = [
      if (contact.is24h) l10n.emergency24h,
      ?ListingFormat.distance(contact.distanceMeters, l10n, locale),
      ?contact.address,
      ?contact.availabilityNote,
    ].join(' · ');
    final point = contact.location;
    return _CallTile(
      title: contact.name.of(locale) ?? contact.phones.first,
      subtitle: details.isEmpty ? null : details,
      phones: contact.phones,
      trailing: point == null
          ? null
          : IconButton(
              icon: const Icon(Icons.place_outlined),
              tooltip: l10n.emergencyOpenMap,
              // The phone's map app, as chat's shared locations do: the pin
              // works with no data plan for our own tiles.
              onPressed: () => ref
                  .read(externalAppsProvider)
                  .open(
                    Uri.parse(
                      'geo:${point.lat},${point.lng}?q=${point.lat},${point.lng}',
                    ),
                  ),
            ),
    );
  }
}

/// A big call button per number: the screen people open in a panic.
class _CallTile extends ConsumerWidget {
  const _CallTile({
    required this.title,
    required this.phones,
    this.subtitle,
    this.trailing,
    this.emphasise = false,
  });

  final String title;
  final String? subtitle;
  final List<String> phones;
  final Widget? trailing;
  final bool emphasise;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              children: [
                for (final phone in phones)
                  FilledButton.icon(
                    style: emphasise
                        ? FilledButton.styleFrom(
                            backgroundColor: colors.error,
                            foregroundColor: colors.onError,
                          )
                        : null,
                    icon: const Icon(Icons.call),
                    label: Text(localizeDigits(phone, locale)),
                    onPressed: () => _call(context, ref, phone, l10n),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _call(
    BuildContext context,
    WidgetRef ref,
    String phone,
    AppLocalizations l10n,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final opened = await ref
        .read(externalAppsProvider)
        .open(Uri(scheme: 'tel', path: phone));
    if (!opened) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.emergencyCallFailed(phone))),
      );
    }
  }
}
