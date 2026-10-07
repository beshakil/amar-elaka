import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/directions.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../place_feedback/presentation/place_report_flow.dart';
import '../data/place_detail_api.dart';

/// The week as people here read it: Saturday first (ISO 6, 7, 1 … 5).
const _weekOrder = [6, 7, 1, 2, 3, 4, 5];

/// A place's own screen: what it is, whether it is open now, its week, how
/// to reach it, and the member's actions on it — save, report, suggest a fix
/// (ADR 051). Saved places, place notifications and claims open here.
class PlaceDetailScreen extends ConsumerWidget {
  const PlaceDetailScreen({required this.placeId, super.key});

  final String placeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final place = ref.watch(placeDetailProvider(placeId));
    return Scaffold(
      appBar: AppBar(
        title: Text(place.asData?.value.nameBn ?? l10n.placeDetailTitle),
      ),
      body: switch (place) {
        AsyncData(:final value) => _PlaceBody(place: value),
        AsyncError(:final error) => ErrorState(
          key: const ValueKey('place-error'),
          title: error is ApiException && error.statusCode == 404
              ? l10n.placeNotFound
              : l10n.placeLoadFailed,
          retryLabel: l10n.placeFeedbackRetry,
          onRetry: () => ref.invalidate(placeDetailProvider(placeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _PlaceBody extends ConsumerWidget {
  const _PlaceBody({required this.place});

  final PlaceDetail place;

  Future<void> _call(BuildContext context, WidgetRef ref, String phone) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final ok = await ref
        .read(externalAppsProvider)
        .open(Uri(scheme: 'tel', path: phone));
    if (!ok) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.mapCallFailed)));
    }
  }

  Future<void> _directions(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final opened = await Directions.open(
      ref.read(externalAppsProvider),
      place.location.lat,
      place.location.lng,
    );
    if (!opened) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.mapDirectionsFailed)));
    }
  }

  Future<void> _save(BuildContext context, WidgetRef ref) async {
    if (!requireLogin(context, ref)) return;
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    String message;
    try {
      final created = await ref.read(placeDetailApiProvider).save(place.id);
      message = created ? l10n.placeSaved : l10n.placeAlreadySaved;
    } on AppException {
      message = l10n.placeSaveFailed;
    }
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final closedBanner = switch (place.status) {
      'permanently_closed' => l10n.placePermanentlyClosed,
      'temporarily_closed' => l10n.placeTemporarilyClosed,
      _ when place.possiblyClosed => l10n.placePossiblyClosed,
      _ => null,
    };
    final (openLabel, openColor) = switch (place.openState) {
      'open' => (l10n.placeOpenStateOpen, Colors.green.shade700),
      'closes_soon' => (l10n.placeOpenStateClosesSoon, Colors.orange.shade800),
      'opens_soon' => (l10n.placeOpenStateOpensSoon, Colors.orange.shade800),
      'closed' => (l10n.placeOpenStateClosed, theme.colorScheme.error),
      _ => (l10n.placeOpenStateUnknown, theme.colorScheme.onSurfaceVariant),
    };

    return ListView(
      key: const ValueKey('place-detail'),
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          place.nameBn,
          key: const ValueKey('place-name'),
          style: theme.textTheme.headlineSmall,
        ),
        if (place.nameEn case final en? when en.isNotEmpty)
          Text(en, style: theme.textTheme.bodyMedium),
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.xs,
          children: [
            Chip(
              key: const ValueKey('place-open-state'),
              avatar: Icon(Icons.schedule, size: 18, color: openColor),
              label: Text(openLabel, style: TextStyle(color: openColor)),
            ),
            if (place.fieldVerified)
              Chip(
                avatar: const Icon(Icons.verified_outlined, size: 18),
                label: Text(l10n.placeFieldVerified),
              ),
            if (place.claimed)
              Chip(
                avatar: const Icon(Icons.storefront_outlined, size: 18),
                label: Text(l10n.placeClaimed),
              ),
          ],
        ),
        if (closedBanner != null)
          Card(
            key: const ValueKey('place-closed-banner'),
            color: theme.colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Text(
                closedBanner,
                style: TextStyle(color: theme.colorScheme.onErrorContainer),
              ),
            ),
          ),
        if (place.addressText case final address? when address.isNotEmpty)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.place_outlined),
            title: Text(address),
          ),
        if (place.description case final text? when text.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(text, style: theme.textTheme.bodyMedium),
          ),
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.xs,
          children: [
            if (place.phones.isNotEmpty)
              FilledButton.icon(
                key: const ValueKey('place-call'),
                icon: const Icon(Icons.call),
                label: Text(l10n.mapPreviewCall),
                onPressed: () =>
                    unawaited(_call(context, ref, place.phones.first)),
              ),
            OutlinedButton.icon(
              key: const ValueKey('place-directions'),
              icon: const Icon(Icons.directions),
              label: Text(l10n.mapPreviewDirections),
              onPressed: () => unawaited(_directions(context, ref)),
            ),
            OutlinedButton.icon(
              key: const ValueKey('place-save'),
              icon: const Icon(Icons.bookmark_add_outlined),
              label: Text(l10n.placeSave),
              onPressed: () => unawaited(_save(context, ref)),
            ),
          ],
        ),
        // More than one number: each can be called.
        if (place.phones.length > 1)
          for (final phone in place.phones)
            ListTile(
              key: ValueKey('place-phone-$phone'),
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.phone_outlined),
              title: Text(localizeDigits(phone, locale)),
              onTap: () => unawaited(_call(context, ref, phone)),
            ),
        const SizedBox(height: AppSpacing.md),
        Text(l10n.placeHoursTitle, style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.xs),
        if (place.hours.isEmpty)
          Text(
            l10n.placeHoursUnknown,
            key: const ValueKey('place-hours-unknown'),
          )
        else
          for (final day in _weekOrder)
            Padding(
              key: ValueKey('place-hours-$day'),
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
              child: Row(
                children: [
                  SizedBox(width: 56, child: Text(_dayName(l10n, day))),
                  Expanded(
                    child: Text(
                      _rangesOf(day, l10n, locale),
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          spacing: AppSpacing.sm,
          children: [
            TextButton.icon(
              key: const ValueKey('place-suggest'),
              icon: const Icon(Icons.edit_outlined),
              label: Text(l10n.placeSuggestOpen),
              onPressed: () {
                if (!requireLogin(context, ref)) return;
                unawaited(context.push(RoutePaths.placeSuggestFor(place.id)));
              },
            ),
            TextButton.icon(
              key: const ValueKey('place-report'),
              icon: const Icon(Icons.flag_outlined),
              label: Text(l10n.placeReportOpen),
              onPressed: () => unawaited(
                reportPlace(
                  context,
                  ref,
                  placeId: place.id,
                  location: place.location,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  String _rangesOf(int day, AppLocalizations l10n, String locale) {
    final ranges = place.hours.where((h) => h.day == day).toList()
      ..sort((a, b) => a.opens.compareTo(b.opens));
    if (ranges.isEmpty) return l10n.placeSuggestClosed;
    return ranges
        .map((r) => localizeDigits('${r.opens}–${r.closes}', locale))
        .join(', ');
  }

  static String _dayName(AppLocalizations l10n, int day) => switch (day) {
    1 => l10n.placeDayMon,
    2 => l10n.placeDayTue,
    3 => l10n.placeDayWed,
    4 => l10n.placeDayThu,
    5 => l10n.placeDayFri,
    6 => l10n.placeDaySat,
    _ => l10n.placeDaySun,
  };
}
