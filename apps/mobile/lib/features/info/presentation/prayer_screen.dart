import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/current_tenant.dart';
import '../application/info_engine_providers.dart';
import '../data/info_engine_models.dart';
import '../prayer/prayer_times.dart';
import 'info_engine_labels.dart';

/// Where prayer times are calculated: the phone's position if already
/// allowed, else the area's centre (from the kept settings or the config).
final prayerPlaceProvider =
    FutureProvider.autoDispose<({double lat, double lng})?>((ref) async {
      final origin = await ref.watch(infoOriginProvider.future);
      if (origin != null) return origin;
      final settings = await ref.watch(prayerSettingsProvider.future);
      if (settings.lat != null && settings.lng != null) {
        return (lat: settings.lat!, lng: settings.lng!);
      }
      final center = ref.watch(currentTenantConfigProvider)?.mapCenter;
      return center == null ? null : (lat: center.lat, lng: center.lng);
    });

String prayerName(Prayer p, AppLocalizations l10n) => switch (p) {
  Prayer.fajr => l10n.prayerFajr,
  Prayer.sunrise => l10n.prayerSunrise,
  Prayer.dhuhr => l10n.prayerDhuhr,
  Prayer.asr => l10n.prayerAsr,
  Prayer.maghrib => l10n.prayerMaghrib,
  Prayer.isha => l10n.prayerIsha,
};

String _hm(DateTime at, String locale) =>
    localizeDigits(DateFormat.jm(locale).format(at.toLocal()), locale);

PrayerDay _day(
  DateTime date,
  ({double lat, double lng}) at,
  PrayerSettings s,
) =>
    prayerTimes(date, at.lat, at.lng, method: s.method, asrSchool: s.asrSchool);

/// Today's times, the next prayer, the Hijri date — and in Ramadan (or on
/// request) the month's sehri and iftar. Calculated on the phone (ADR 065).
class PrayerScreen extends ConsumerStatefulWidget {
  const PrayerScreen({super.key});

  @override
  ConsumerState<PrayerScreen> createState() => _PrayerScreenState();
}

class _PrayerScreenState extends ConsumerState<PrayerScreen> {
  Timer? _tick;
  bool _ramadan = false;

  @override
  void initState() {
    super.initState();
    // The "next" line moves on with the clock.
    _tick = Timer.periodic(const Duration(minutes: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final settings =
        ref.watch(prayerSettingsProvider).value ?? PrayerSettings.fallback;
    final place = ref.watch(prayerPlaceProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.infoHubPrayerTitle)),
      body: switch (place) {
        AsyncData(value: final at?) => _body(
          context,
          l10n,
          locale,
          settings,
          at,
        ),
        AsyncData() => Center(child: Text(l10n.prayerPlaceNote)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Widget _body(
    BuildContext context,
    AppLocalizations l10n,
    String locale,
    PrayerSettings s,
    ({double lat, double lng}) at,
  ) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final t = _day(today, at, s);
    final next = nextPrayer(
      t,
      _day(today.add(const Duration(days: 1)), at, s),
      now.toUtc(),
    );
    final h = hijriDate(today, s.hijriAdjustDays);
    final inRamadan = h.month == ramadan;
    final text = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          l10n.prayerHijri(
            localizeDigits('${h.day}', locale),
            InfoEngineLabels.hijriMonth(h.month, l10n),
            localizeDigits('${h.year}', locale),
          ),
          style: text.titleMedium,
        ),
        if (next != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(
              l10n.prayerNext(
                prayerName(next.prayer, l10n),
                _hm(next.at, locale),
              ),
              style: text.titleLarge?.copyWith(
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ),
        AppCard(
          child: Column(
            children: [
              for (final p in Prayer.values)
                ListTile(
                  dense: true,
                  selected: next?.prayer == p && next!.at.day == t[p]!.day,
                  leading: Icon(
                    p == Prayer.sunrise ? Icons.wb_twilight : Icons.access_time,
                  ),
                  title: Text(prayerName(p, l10n)),
                  trailing: Text(_hm(t[p]!, locale), style: text.titleMedium),
                ),
            ],
          ),
        ),
        if (inRamadan) _sehriIftarToday(context, l10n, locale, t, s),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.prayerRamadan),
          value: _ramadan || inRamadan,
          onChanged: inRamadan ? null : (v) => setState(() => _ramadan = v),
        ),
        if (_ramadan || inRamadan)
          _RamadanTable(settings: s, at: at, from: today),
        const SizedBox(height: AppSpacing.md),
        Text(
          l10n.prayerBasis(
            InfoEngineLabels.method(s.method, l10n),
            s.asrSchool == 'hanafi'
                ? l10n.prayerMethodHanafi
                : l10n.prayerMethodStandard,
          ),
          style: text.bodySmall,
        ),
        Text(l10n.prayerPlaceNote, style: text.bodySmall),
      ],
    );
  }

  Widget _sehriIftarToday(
    BuildContext context,
    AppLocalizations l10n,
    String locale,
    PrayerDay t,
    PrayerSettings s,
  ) {
    final si = sehriIftar(
      t,
      sehriCautionMinutes: s.sehriCautionMinutes,
      iftarCautionMinutes: s.iftarCautionMinutes,
    );
    final style = Theme.of(context).textTheme.titleLarge;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Row(
        children: [
          Expanded(
            child: AppCard(
              child: Column(
                children: [
                  Text(l10n.prayerSehriEnds),
                  Text(_hm(si.sehriEnds, locale), style: style),
                ],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: AppCard(
              child: Column(
                children: [
                  Text(l10n.prayerIftar),
                  Text(_hm(si.iftar, locale), style: style),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The month's sehri and iftar from today (30 days).
class _RamadanTable extends StatelessWidget {
  const _RamadanTable({
    required this.settings,
    required this.at,
    required this.from,
  });

  final PrayerSettings settings;
  final ({double lat, double lng}) at;
  final DateTime from;

  // A month of rows: the length of Ramadan, at most (a calendar fact).
  static const _days = 30;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Table(
      columnWidths: const {
        0: FlexColumnWidth(2),
        1: FlexColumnWidth(2),
        2: FlexColumnWidth(2),
      },
      children: [
        TableRow(
          children: [
            for (final h in [
              l10n.prayerDate,
              l10n.prayerSehriEnds,
              l10n.prayerIftar,
            ])
              Padding(
                padding: const EdgeInsets.all(AppSpacing.xs),
                child: Text(
                  h,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
          ],
        ),
        for (var i = 0; i < _days; i++)
          () {
            final day = from.add(Duration(days: i));
            final si = sehriIftar(
              _day(day, at, settings),
              sehriCautionMinutes: settings.sehriCautionMinutes,
              iftarCautionMinutes: settings.iftarCautionMinutes,
            );
            final h = hijriDate(day, settings.hijriAdjustDays);
            return TableRow(
              children: [
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  child: Text(
                    '${localizeDigits(DateFormat.MMMd(locale).format(day), locale)}'
                    '${h.month == ramadan ? ' · ${localizeDigits('${h.day}', locale)}' : ''}',
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  child: Text(_hm(si.sehriEnds, locale)),
                ),
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  child: Text(_hm(si.iftar, locale)),
                ),
              ],
            );
          }(),
      ],
    );
  }
}

/// The feed's prayer card: the next prayer, calculated here.
class PrayerFeedCard extends ConsumerWidget {
  const PrayerFeedCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final settings =
        ref.watch(prayerSettingsProvider).value ?? PrayerSettings.fallback;
    final at = ref.watch(prayerPlaceProvider).value;
    if (at == null) return const SizedBox.shrink();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final next = nextPrayer(
      _day(today, at, settings),
      _day(today.add(const Duration(days: 1)), at, settings),
      now.toUtc(),
    );
    return AppCard(
      onTap: () => context.push(RoutePaths.prayer),
      child: Row(
        children: [
          Icon(
            Icons.mosque_outlined,
            color: Theme.of(context).colorScheme.primary,
            size: 32,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.prayerFeedTitle,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (next != null)
                  Text(
                    l10n.prayerNext(
                      prayerName(next.prayer, l10n),
                      _hm(next.at, locale),
                    ),
                  ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right),
        ],
      ),
    );
  }
}
