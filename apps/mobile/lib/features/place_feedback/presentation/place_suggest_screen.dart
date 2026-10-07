import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/location_picker.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../data/place_feedback_api.dart';
import 'place_feedback_messages.dart';

/// The week as people here read it: Saturday first (ISO 6, 7, 1 … 5).
const _weekOrder = [6, 7, 1, 2, 3, 4, 5];

/// One day of the hours editor: open or not, and one range.
class _Day {
  _Day({required this.open, required this.opens, required this.closes});

  bool open;
  TimeOfDay opens;
  TimeOfDay closes;

  /// The place has several ranges that day (a split shift): kept as they
  /// are unless the member edits the day.
  List<HoursRange> split = const [];
  bool touched = false;
}

/// "তথ্য সংশোধন" (ADR 051): suggest a better location, phone numbers or
/// weekly hours for a place. Only what the member changes is sent; a
/// moderator approves it before the map changes.
class PlaceSuggestScreen extends ConsumerStatefulWidget {
  const PlaceSuggestScreen({required this.placeId, super.key});

  final String placeId;

  @override
  ConsumerState<PlaceSuggestScreen> createState() => _PlaceSuggestScreenState();
}

class _PlaceSuggestScreenState extends ConsumerState<PlaceSuggestScreen> {
  PlaceSnapshot? _place;
  AppException? _loadError;
  GeoPoint? _location;
  final _phones = TextEditingController();
  final _note = TextEditingController();
  final _days = <int, _Day>{};
  bool _editHours = false;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _phones.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final place = await ref
          .read(placeFeedbackApiProvider)
          .place(widget.placeId);
      if (!mounted) return;
      setState(() {
        _place = place;
        _loadError = null;
        _phones.text = place.phones.map(_local).join(', ');
        for (final day in _weekOrder) {
          final ranges = place.hours.where((h) => h.day == day).toList();
          _days[day] = _Day(
            open: ranges.isNotEmpty,
            opens: ranges.isEmpty
                ? const TimeOfDay(hour: 9, minute: 0)
                : _time(ranges.first.opens),
            closes: ranges.isEmpty
                ? const TimeOfDay(hour: 21, minute: 0)
                : _time(ranges.first.closes),
          )..split = ranges.length > 1 ? ranges : const [];
        }
      });
    } on AppException catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  static String _local(String e164) =>
      e164.startsWith('+88') ? e164.substring(3) : e164;

  static TimeOfDay _time(String hhmm) {
    final parts = hhmm.split(':');
    return TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1]));
  }

  static String _clock(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  List<String> get _phoneList => _phones.text
      .split(RegExp(r'[,\n]'))
      .map((p) => p.trim())
      .where((p) => p.isNotEmpty)
      .toList();

  List<HoursRange> get _hours => [
    for (final day in _weekOrder)
      if (_days[day] case final d? when d.open)
        if (!d.touched && d.split.isNotEmpty)
          ...d.split
        else
          (day: day, opens: _clock(d.opens), closes: _clock(d.closes)),
  ];

  bool get _phonesChanged {
    final place = _place;
    if (place == null) return false;
    final now = _phoneList.map(_canonical).toSet();
    final before = place.phones.map(_local).map(_canonical).toSet();
    return now.length != before.length || !now.containsAll(before);
  }

  /// Digits only, without the country code: how two numbers compare here.
  static String _canonical(String phone) {
    final digits = phone.replaceAll(RegExp(r'\D'), '');
    return digits.startsWith('88') ? digits.substring(2) : digits;
  }

  bool get _hoursChanged {
    final place = _place;
    if (place == null || !_editHours) return false;
    String key(HoursRange h) => '${h.day}-${h.opens}-${h.closes}';
    final now = _hours.map(key).toSet();
    final before = place.hours.map(key).toSet();
    return now.length != before.length || !now.containsAll(before);
  }

  bool get _anything => _location != null || _phonesChanged || _hoursChanged;

  Future<void> _pickLocation() async {
    final place = _place;
    if (place == null) return;
    final picked = await Navigator.of(context).push<GeoPoint>(
      MaterialPageRoute(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: Text(AppLocalizations.of(context)!.placeSuggestPickTitle),
          ),
          body: LocationPicker(
            purpose: 'place_marking',
            initial: _location ?? place.location,
            onChanged: (_) {},
            onConfirm: (location) => Navigator.of(context).pop(location.point),
          ),
        ),
      ),
    );
    if (picked != null && mounted) setState(() => _location = picked);
  }

  Future<void> _pickTime(_Day day, {required bool opening}) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: opening ? day.opens : day.closes,
    );
    if (picked == null || !mounted) return;
    setState(() {
      day.touched = true;
      if (opening) {
        day.opens = picked;
      } else {
        day.closes = picked;
      }
    });
  }

  Future<void> _send() async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _sending = true);
    try {
      await ref
          .read(placeFeedbackApiProvider)
          .suggest(
            widget.placeId,
            location: _location,
            phones: _phonesChanged ? _phoneList : null,
            hours: _hoursChanged ? _hours : null,
            note: _note.text,
          );
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.placeSuggestSent)));
      Navigator.of(context).pop(true);
    } on AppException catch (error) {
      if (!mounted) return;
      setState(() => _sending = false);
      messenger.showSnackBar(
        SnackBar(content: Text(placeFeedbackError(error, l10n, locale))),
      );
    }
  }

  String _dayName(AppLocalizations l10n, int day) => switch (day) {
    1 => l10n.placeDayMon,
    2 => l10n.placeDayTue,
    3 => l10n.placeDayWed,
    4 => l10n.placeDayThu,
    5 => l10n.placeDayFri,
    6 => l10n.placeDaySat,
    _ => l10n.placeDaySun,
  };

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final place = _place;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.placeSuggestTitle)),
      body: switch ((place, _loadError)) {
        (null, final error?) => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  placeFeedbackError(error, l10n, locale),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.sm),
                TextButton(
                  onPressed: _load,
                  child: Text(l10n.placeFeedbackRetry),
                ),
              ],
            ),
          ),
        ),
        (null, _) => const Center(child: CircularProgressIndicator()),
        (final place?, _) => ListView(
          key: const ValueKey('place-suggest'),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Text(place.nameBn, style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs),
            Text(l10n.placeSuggestIntro, style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.md),
            ListTile(
              key: const ValueKey('place-suggest-location'),
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.edit_location_alt_outlined),
              title: Text(l10n.placeSuggestLocation),
              subtitle: Text(
                _location == null
                    ? l10n.placeSuggestLocationHint
                    : l10n.placeSuggestLocationPicked,
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: _pickLocation,
            ),
            const Divider(),
            TextField(
              key: const ValueKey('place-suggest-phones'),
              controller: _phones,
              keyboardType: TextInputType.phone,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: l10n.placeSuggestPhones,
                helperText: l10n.placeSuggestPhonesHint,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            SwitchListTile(
              key: const ValueKey('place-suggest-edit-hours'),
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.placeSuggestHours),
              value: _editHours,
              onChanged: (value) => setState(() => _editHours = value),
            ),
            if (_editHours)
              for (final day in _weekOrder)
                if (_days[day] case final d?)
                  Row(
                    key: ValueKey('place-suggest-day-$day'),
                    children: [
                      SizedBox(width: 56, child: Text(_dayName(l10n, day))),
                      Switch(
                        value: d.open,
                        onChanged: (value) => setState(() {
                          d.open = value;
                          d.touched = true;
                        }),
                      ),
                      if (d.open && !d.touched && d.split.isNotEmpty)
                        Expanded(
                          child: Text(
                            d.split
                                .map(
                                  (r) => localizeDigits(
                                    '${r.opens}–${r.closes}',
                                    locale,
                                  ),
                                )
                                .join(', '),
                            style: theme.textTheme.bodySmall,
                          ),
                        )
                      else if (d.open) ...[
                        TextButton(
                          onPressed: () => _pickTime(d, opening: true),
                          child: Text(localizeDigits(_clock(d.opens), locale)),
                        ),
                        const Text('–'),
                        TextButton(
                          onPressed: () => _pickTime(d, opening: false),
                          child: Text(localizeDigits(_clock(d.closes), locale)),
                        ),
                      ] else
                        Text(
                          l10n.placeSuggestClosed,
                          style: theme.textTheme.bodySmall,
                        ),
                    ],
                  ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              key: const ValueKey('place-suggest-note'),
              controller: _note,
              maxLines: 2,
              decoration: InputDecoration(labelText: l10n.placeSuggestNote),
            ),
            const SizedBox(height: AppSpacing.lg),
            AppButton(
              key: const ValueKey('place-suggest-send'),
              label: l10n.placeSuggestSend,
              isLoading: _sending,
              onPressed: _anything && !_sending
                  ? () => unawaited(_send())
                  : null,
            ),
          ],
        ),
      },
    );
  }
}
