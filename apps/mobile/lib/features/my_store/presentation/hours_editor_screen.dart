import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';
import '../domain/hours_draft.dart';
import 'store_messages.dart';

String dayName(AppLocalizations l10n, int day) => switch (day) {
  1 => l10n.placeDayMon,
  2 => l10n.placeDayTue,
  3 => l10n.placeDayWed,
  4 => l10n.placeDayThu,
  5 => l10n.placeDayFri,
  6 => l10n.placeDaySat,
  _ => l10n.placeDaySun,
};

/// The store's hours (ADR 054/057): each day closed or open in as many
/// shifts as it has (a lunch break is two shifts), copied to every day in
/// one tap; and holidays — closed all day, or open at other hours.
class HoursEditorScreen extends ConsumerWidget {
  const HoursEditorScreen({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final hours = ref.watch(storeHoursProvider(storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.hoursTitle)),
      body: switch (hours) {
        AsyncData(:final value) => _HoursForm(storeId: storeId, hours: value),
        AsyncError() => ErrorState(
          title: l10n.myStoreLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(storeHoursProvider(storeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _HoursForm extends ConsumerStatefulWidget {
  const _HoursForm({required this.storeId, required this.hours});

  final String storeId;
  final StoreHours hours;

  @override
  ConsumerState<_HoursForm> createState() => _HoursFormState();
}

class _HoursFormState extends ConsumerState<_HoursForm> {
  late final HoursDraft _draft = HoursDraft.fromWeekly(widget.hours.weekly);
  late final List<SpecialDay> _holidays = List.of(widget.hours.specialDays);
  bool _saving = false;
  String? _error;

  AppLocalizations get _l10n => AppLocalizations.of(context)!;
  String get _locale => Localizations.localeOf(context).languageCode;

  String _time(int minutes) => localizeDigits(Shift.format(minutes), _locale);

  Future<int?> _pick(int minutes) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: minutes ~/ 60, minute: minutes % 60),
    );
    return picked == null ? null : picked.hour * 60 + picked.minute;
  }

  Future<void> _editShift(int day, int index, {required bool opening}) async {
    final shift = _draft.days[day]![index];
    final minutes = await _pick(opening ? shift.opens : shift.closes);
    if (minutes == null || !mounted) return;
    setState(() {
      _draft.setShift(
        day,
        index,
        opening ? Shift(minutes, shift.closes) : Shift(shift.opens, minutes),
      );
      _error = null;
    });
  }

  Future<void> _addHoliday() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      firstDate: now,
      lastDate: now.add(const Duration(days: 366)),
    );
    if (date == null || !mounted) return;
    final iso =
        '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    setState(() {
      _holidays
        ..removeWhere((d) => d.date == iso)
        ..add(SpecialDay(date: iso, closed: true))
        ..sort((a, b) => a.date.compareTo(b.date));
    });
  }

  Future<void> _save() async {
    final l10n = _l10n;
    final messenger = ScaffoldMessenger.of(context);
    final issues = _draft.issues();
    if (issues.isNotEmpty) {
      setState(
        () => _error = switch (issues.first) {
          SameTimes() => l10n.hoursSameTimes,
          Overlap(:final day) => l10n.hoursOverlap(dayName(l10n, day)),
        },
      );
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(storeApiProvider);
      await api.putWeekly(widget.storeId, _draft.toWeekly());
      await api.putSpecialDays(widget.storeId, _holidays);
      ref.invalidate(storeHoursProvider(widget.storeId));
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.myStoreSaved)));
      Navigator.of(context).pop();
    } on AppException catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = storeErrorMessage(error, l10n, _locale);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = _l10n;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        for (final day in weekOrder) ...[
          Row(
            children: [
              Expanded(
                child: Text(
                  dayName(l10n, day),
                  style: theme.textTheme.titleSmall,
                ),
              ),
              Text(_draft.isOpen(day) ? l10n.hoursOpen : l10n.hoursClosed),
              Switch(
                key: ValueKey('hours-open-$day'),
                value: _draft.isOpen(day),
                onChanged: (open) => setState(() {
                  _draft.setOpen(day, open: open);
                  _error = null;
                }),
              ),
            ],
          ),
          for (final (i, shift) in _draft.days[day]!.indexed)
            Row(
              key: ValueKey('hours-shift-$day-$i'),
              children: [
                const SizedBox(width: AppSpacing.md),
                TextButton(
                  onPressed: () => unawaited(_editShift(day, i, opening: true)),
                  child: Text('${l10n.hoursOpens} ${_time(shift.opens)}'),
                ),
                const Text('–'),
                TextButton(
                  onPressed: () =>
                      unawaited(_editShift(day, i, opening: false)),
                  child: Text('${l10n.hoursCloses} ${_time(shift.closes)}'),
                ),
                const Spacer(),
                IconButton(
                  tooltip: l10n.hoursRemoveShift,
                  icon: const Icon(Icons.remove_circle_outline),
                  onPressed: () => setState(() => _draft.removeShift(day, i)),
                ),
              ],
            ),
          if (_draft.isOpen(day))
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                TextButton.icon(
                  key: ValueKey('hours-add-$day'),
                  icon: const Icon(Icons.add),
                  label: Text(l10n.hoursAddShift),
                  onPressed: () => setState(() => _draft.addShift(day)),
                ),
                TextButton.icon(
                  key: ValueKey('hours-copy-$day'),
                  icon: const Icon(Icons.copy_all_outlined),
                  label: Text(l10n.hoursCopyToAll),
                  onPressed: () => setState(() => _draft.copyToAll(day)),
                ),
              ],
            ),
          const Divider(),
        ],
        const SizedBox(height: AppSpacing.sm),
        Text(l10n.hoursHolidays, style: theme.textTheme.titleMedium),
        if (_holidays.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(l10n.hoursNoHolidays),
          ),
        for (final (i, holiday) in _holidays.indexed)
          _HolidayRow(
            key: ValueKey('hours-holiday-${holiday.date}'),
            holiday: holiday,
            onChanged: (updated) => setState(() => _holidays[i] = updated),
            onRemove: () => setState(() => _holidays.removeAt(i)),
            pickTime: _pick,
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            key: const ValueKey('hours-add-holiday'),
            icon: const Icon(Icons.event_busy_outlined),
            label: Text(l10n.hoursAddHoliday),
            onPressed: () => unawaited(_addHoliday()),
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(
              _error!,
              key: const ValueKey('hours-error'),
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: const ValueKey('hours-save'),
          label: l10n.hoursSave,
          isLoading: _saving,
          onPressed: _saving ? null : () => unawaited(_save()),
        ),
      ],
    );
  }
}

/// One holiday: its date, closed all day or one range of special hours, a note.
class _HolidayRow extends StatefulWidget {
  const _HolidayRow({
    required this.holiday,
    required this.onChanged,
    required this.onRemove,
    required this.pickTime,
    super.key,
  });

  final SpecialDay holiday;
  final ValueChanged<SpecialDay> onChanged;
  final VoidCallback onRemove;
  final Future<int?> Function(int minutes) pickTime;

  @override
  State<_HolidayRow> createState() => _HolidayRowState();
}

class _HolidayRowState extends State<_HolidayRow> {
  late final _note = TextEditingController(text: widget.holiday.note);

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  SpecialDay _with({bool? closed, ({String opens, String closes})? range}) {
    final h = widget.holiday;
    final isClosed = closed ?? h.closed;
    return SpecialDay(
      date: h.date,
      closed: isClosed,
      ranges: isClosed
          ? const []
          : [
              range ??
                  (h.ranges.isEmpty
                      ? (opens: '10:00', closes: '18:00')
                      : h.ranges.first),
            ],
      note: _note.text.trim(),
    );
  }

  Future<void> _edit({required bool opening}) async {
    final range = widget.holiday.ranges.first;
    final current = Shift.parse(range.opens, range.closes);
    final minutes = await widget.pickTime(
      opening ? current.opens : current.closes,
    );
    if (minutes == null) return;
    final value = Shift.format(minutes);
    widget.onChanged(
      _with(
        range: opening
            ? (opens: value, closes: range.closes)
            : (opens: range.opens, closes: value),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final h = widget.holiday;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(localizeDigits(h.date, locale))),
                TextButton(
                  onPressed: widget.onRemove,
                  child: Text(l10n.hoursRemoveHoliday),
                ),
              ],
            ),
            SegmentedButton<bool>(
              segments: [
                ButtonSegment(
                  value: true,
                  label: Text(l10n.hoursHolidayClosed),
                ),
                ButtonSegment(
                  value: false,
                  label: Text(l10n.hoursHolidaySpecial),
                ),
              ],
              selected: {h.closed},
              onSelectionChanged: (s) =>
                  widget.onChanged(_with(closed: s.first)),
            ),
            if (!h.closed && h.ranges.isNotEmpty)
              Row(
                children: [
                  TextButton(
                    onPressed: () => unawaited(_edit(opening: true)),
                    child: Text(
                      '${l10n.hoursOpens} ${localizeDigits(h.ranges.first.opens, locale)}',
                    ),
                  ),
                  const Text('–'),
                  TextButton(
                    onPressed: () => unawaited(_edit(opening: false)),
                    child: Text(
                      '${l10n.hoursCloses} ${localizeDigits(h.ranges.first.closes, locale)}',
                    ),
                  ),
                ],
              ),
            TextField(
              controller: _note,
              decoration: InputDecoration(labelText: l10n.hoursHolidayNote),
              onChanged: (_) => widget.onChanged(_with()),
            ),
          ],
        ),
      ),
    );
  }
}
