import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/current_tenant.dart';
import '../../post/presentation/widgets/category_icon.dart';
import '../application/agent_providers.dart';
import '../data/agent_api.dart';
import '../data/agent_capture_store.dart';
import '../data/agent_models.dart';
import '../data/gps_source.dart';
import '../domain/capture_rules.dart';
import 'agent_labels.dart';

/// A random (version 4) UUID: the submission's id from the moment the
/// capture begins — the server's idempotency key for its sync.
String newCaptureId([Random? random]) {
  final r = random ?? Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final hex = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Capturing a shop in front of it (ADR 066), fully offline: a GPS fix (the
/// save waits for one at least agent_min_gps_accuracy_m good), the shop
/// front, its name, kind, phone (OTP when online), hours in a tap, notes.
/// Saving queues it; the sync sends it when there is a network.
class AgentCaptureScreen extends ConsumerStatefulWidget {
  const AgentCaptureScreen({super.key, this.task, this.picker});

  /// From today's route: the task this answers (and the shop, to verify or update).
  final AgentTask? task;

  /// Injectable for tests.
  final ImagePicker? picker;

  @override
  ConsumerState<AgentCaptureScreen> createState() => _AgentCaptureScreenState();
}

class _AgentCaptureScreenState extends ConsumerState<AgentCaptureScreen> {
  late final String _id = newCaptureId();
  StreamSubscription<GpsFix>? _gps;
  bool _gpsAllowed = true;
  GpsFix? _fix;
  GpsFix? _photoFix;
  DateTime? _photoTakenAt;
  final _photos = <CapturedPhoto>[];
  bool _photoBusy = false;
  final _name = TextEditingController();
  final _nameEn = TextEditingController();
  final _phone = TextEditingController();
  final _notes = TextEditingController();
  String? _categoryId;
  HoursPreset? _preset;
  List<Map<String, Object>>? _customHours;
  String? _phoneCheck;
  bool _saving = false;

  String get _kind => switch (widget.task?.type) {
    'verify_shop' => 'verify_shop',
    'update_info' => 'update_info',
    _ => 'new_shop',
  };

  @override
  void initState() {
    super.initState();
    unawaited(_startGps());
  }

  Future<void> _startGps() async {
    final gps = ref.read(gpsSourceProvider);
    if (!await gps.ensureAllowed()) {
      if (mounted) setState(() => _gpsAllowed = false);
      return;
    }
    _gps = gps.fixes().listen((fix) {
      if (mounted) setState(() => _fix = fix);
    });
  }

  @override
  void dispose() {
    unawaited(_gps?.cancel());
    for (final c in [_name, _nameEn, _phone, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _takePhoto(int photosMax) async {
    if (_photos.length >= photosMax) return;
    final picked = await (widget.picker ?? ImagePicker()).pickImage(
      source: ImageSource.camera,
    );
    if (picked == null || !mounted) return;
    // Where and when the shutter was: the anti-fraud check compares it with the save.
    _photoFix ??= _fix;
    _photoTakenAt ??= DateTime.now();
    setState(() => _photoBusy = true);
    try {
      final kept = await ref
          .read(capturePhotoProcessorProvider)
          .keep(picked.path, _id, _photos.length);
      if (mounted) setState(() => _photos.add(kept));
    } finally {
      if (mounted) setState(() => _photoBusy = false);
    }
  }

  Future<void> _verifyPhone() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final api = ref.read(agentApiProvider);
    final phone = _phone.text.trim();
    try {
      await api.requestPhoneOtp(_id, phone);
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.captureOtpOffline)));
      return;
    }
    if (!mounted) return;
    final code = await showDialog<String>(
      context: context,
      builder: (context) => _OtpDialog(title: l10n.captureOtpSent),
    );
    if (code == null || code.isEmpty) return;
    try {
      await api.verifyPhoneOtp(_id, phone, code);
      setState(() => _phoneCheck = 'verified');
    } on ApiException {
      setState(() => _phoneCheck = 'failed');
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.captureOtpOffline)));
    }
  }

  Future<void> _customHoursSheet() async {
    final result = await showModalBottomSheet<List<Map<String, Object>>>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _CustomHoursSheet(),
    );
    if (result != null) {
      setState(() {
        _customHours = result;
        _preset = null;
      });
    }
  }

  Future<void> _save(AgentMe me) async {
    final l10n = AppLocalizations.of(context)!;
    final tenantId = ref.read(currentTenantConfigProvider)?.id;
    final fix = _fix;
    if (tenantId == null || fix == null) return;
    setState(() => _saving = true);
    final hours = _customHours ?? _preset?.toBusinessHours();
    String? opt(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    final title =
        opt(_name) ?? widget.task?.placeName ?? widget.task?.title ?? '';
    final photoFix = _photoFix;
    await ref
        .read(agentCaptureStoreProvider)
        .add(
          id: _id,
          tenantId: tenantId,
          kind: _kind,
          title: title,
          capturedAt: DateTime.now(),
          photos: _photos,
          payload: {
            'kind': _kind,
            'taskId': ?widget.task?.id,
            'placeId': ?widget.task?.placeId,
            'capturedAt': DateTime.now().toUtc().toIso8601String(),
            'location': {'lat': fix.lat, 'lng': fix.lng},
            'accuracyM': fix.accuracyM,
            'photo': photoFix == null
                ? null
                : {
                    'location': {'lat': photoFix.lat, 'lng': photoFix.lng},
                    'takenAt': _photoTakenAt!.toUtc().toIso8601String(),
                  },
            'nameBn': ?opt(_name),
            'nameEn': ?opt(_nameEn),
            'categoryId': ?_categoryId,
            'phone': ?opt(_phone),
            'businessHours': ?hours,
            'notes': ?opt(_notes),
          },
        );
    unawaited(ref.read(agentSyncProvider).syncAll());
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l10n.captureSaved)));
    context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final bootstrap = ref.watch(agentBootstrapProvider).value;
    if (bootstrap == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final me = bootstrap.me;
    final isNew = _kind == 'new_shop';
    final accurate = accurateEnough(_fix?.accuracyM, me.minGpsAccuracyM);
    final complete =
        !isNew ||
        (_photos.isNotEmpty &&
            _name.text.trim().isNotEmpty &&
            _categoryId != null);
    final canSave = accurate && complete && !_saving && !_photoBusy;

    return Scaffold(
      appBar: AppBar(
        title: Text(switch (_kind) {
          'verify_shop' => l10n.captureTitleVerify,
          'update_info' => l10n.captureTitleUpdate,
          _ => l10n.captureTitleNew,
        }),
      ),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          _GpsChip(
            allowed: _gpsAllowed,
            fix: _fix,
            minAccuracyM: me.minGpsAccuracyM,
            locale: locale,
          ),
          if (widget.task != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              widget.task!.placeName ?? widget.task!.title,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              for (final p in _photos)
                ClipRRect(
                  borderRadius: BorderRadius.circular(AppSpacing.xs),
                  child: Image.file(
                    File(p.localPath),
                    width: 96,
                    height: 96,
                    fit: BoxFit.cover,
                  ),
                ),
              if (_photos.length < me.photosMax)
                OutlinedButton.icon(
                  key: const ValueKey('capture-photo'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(96, 96),
                  ),
                  onPressed: _photoBusy ? null : () => _takePhoto(me.photosMax),
                  icon: _photoBusy
                      ? const SizedBox.square(
                          dimension: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.photo_camera_outlined),
                  label: Text(
                    _photos.isEmpty ? l10n.capturePhoto : l10n.captureMorePhoto,
                  ),
                ),
            ],
          ),
          if (isNew) ...[
            const SizedBox(height: AppSpacing.md),
            TextField(
              key: const ValueKey('capture-name'),
              controller: _name,
              decoration: InputDecoration(labelText: l10n.captureName),
              textCapitalization: TextCapitalization.words,
              onChanged: (_) => setState(() {}),
            ),
            TextField(
              controller: _nameEn,
              decoration: InputDecoration(labelText: l10n.captureNameEn),
            ),
            const SizedBox(height: AppSpacing.sm),
            DropdownButtonFormField<String>(
              key: const ValueKey('capture-category'),
              initialValue: _categoryId,
              isExpanded: true,
              decoration: InputDecoration(labelText: l10n.captureCategory),
              items: [
                for (final c in bootstrap.categories)
                  DropdownMenuItem(
                    value: c.id,
                    child: Row(
                      children: [
                        Icon(categoryIcon(c.iconKey), size: 20),
                        const SizedBox(width: AppSpacing.sm),
                        Flexible(
                          child: Text(
                            locale == 'bn' ? c.nameBn : (c.nameEn ?? c.nameBn),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
              onChanged: (v) => setState(() => _categoryId = v),
            ),
          ] else
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text(
                l10n.captureChanges,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(labelText: l10n.capturePhone),
                  onChanged: (_) => setState(() => _phoneCheck = null),
                ),
              ),
              if (_phone.text.trim().isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: AppSpacing.sm),
                  child: switch (_phoneCheck) {
                    'verified' => Chip(
                      avatar: const Icon(Icons.verified, size: 18),
                      label: Text(l10n.captureOtpVerified),
                    ),
                    'failed' => Chip(
                      avatar: const Icon(Icons.error_outline, size: 18),
                      label: Text(l10n.captureOtpFailed),
                    ),
                    _ => TextButton(
                      onPressed: _verifyPhone,
                      child: Text(l10n.captureVerifyPhone),
                    ),
                  },
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            l10n.captureHours,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          Wrap(
            spacing: AppSpacing.xs,
            runSpacing: AppSpacing.xs,
            children: [
              for (final p in hoursPresets)
                ChoiceChip(
                  label: Text(AgentLabels.preset(p, l10n)),
                  selected: _preset == p,
                  onSelected: (_) => setState(() {
                    _preset = p;
                    _customHours = null;
                  }),
                ),
              ChoiceChip(
                label: Text(l10n.captureHoursCustom),
                selected: _customHours != null,
                onSelected: (_) => _customHoursSheet(),
              ),
              ChoiceChip(
                label: Text(l10n.captureHoursUnknown),
                selected: _preset == null && _customHours == null,
                onSelected: (_) => setState(() {
                  _preset = null;
                  _customHours = null;
                }),
              ),
            ],
          ),
          TextField(
            controller: _notes,
            maxLines: 2,
            decoration: InputDecoration(labelText: l10n.captureNotes),
          ),
          const SizedBox(height: AppSpacing.lg),
          if (isNew && _photos.isEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Text(
                l10n.captureNeedPhoto,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          FilledButton(
            key: const ValueKey('capture-save'),
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
            ),
            onPressed: canSave ? () => _save(me) : null,
            child: Text(l10n.captureSave),
          ),
        ],
      ),
    );
  }
}

/// The fix's accuracy, coloured: the save waits for a good-enough one.
class _GpsChip extends StatelessWidget {
  const _GpsChip({
    required this.allowed,
    required this.fix,
    required this.minAccuracyM,
    required this.locale,
  });

  final bool allowed;
  final GpsFix? fix;
  final double minAccuracyM;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final quality = fixQuality(fix?.accuracyM, minAccuracyM);
    final (color, text) = !allowed
        ? (colors.error, l10n.captureGpsOff)
        : switch (quality) {
            FixQuality.none => (colors.outline, l10n.captureGpsWaiting),
            FixQuality.poor => (
              colors.error,
              '${l10n.captureGpsAccuracy(localizeDigits(fix!.accuracyM.round().toString(), locale))} · '
                  '${l10n.captureGpsTooWeak(localizeDigits(minAccuracyM.round().toString(), locale))}',
            ),
            FixQuality.fair => (
              Colors.orange.shade700,
              l10n.captureGpsAccuracy(
                localizeDigits(fix!.accuracyM.round().toString(), locale),
              ),
            ),
            FixQuality.good => (
              Colors.green.shade700,
              l10n.captureGpsAccuracy(
                localizeDigits(fix!.accuracyM.round().toString(), locale),
              ),
            ),
          };
    return Container(
      key: const ValueKey('capture-gps'),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        border: Border.all(color: color, width: 2),
        borderRadius: BorderRadius.circular(AppSpacing.sm),
      ),
      child: Row(
        children: [
          Icon(
            quality == FixQuality.good || quality == FixQuality.fair
                ? Icons.gps_fixed
                : Icons.gps_not_fixed,
            color: color,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: color, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

class _OtpDialog extends StatefulWidget {
  const _OtpDialog({required this.title});

  final String title;

  @override
  State<_OtpDialog> createState() => _OtpDialogState();
}

class _OtpDialogState extends State<_OtpDialog> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _code,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: l10n.captureOtpCode),
        autofocus: true,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(_code.text.trim()),
          child: Text(l10n.captureOtpConfirm),
        ),
      ],
    );
  }
}

/// "Other hours": the days it is open, one opening and one closing time.
class _CustomHoursSheet extends StatefulWidget {
  const _CustomHoursSheet();

  @override
  State<_CustomHoursSheet> createState() => _CustomHoursSheetState();
}

class _CustomHoursSheetState extends State<_CustomHoursSheet> {
  final _days = {...everyDay};
  TimeOfDay _opens = const TimeOfDay(hour: 9, minute: 0);
  TimeOfDay _closes = const TimeOfDay(hour: 21, minute: 0);

  String _hm(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final names = MaterialLocalizations.of(context).narrowWeekdays;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l10n.captureHoursDays,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            Wrap(
              spacing: AppSpacing.xs,
              children: [
                for (final d in everyDay)
                  FilterChip(
                    // narrowWeekdays starts on Sunday; ISO 7 = Sunday.
                    label: Text(names[d % 7]),
                    selected: _days.contains(d),
                    onSelected: (on) =>
                        setState(() => on ? _days.add(d) : _days.remove(d)),
                  ),
              ],
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.captureHoursOpens),
              trailing: Text(_opens.format(context)),
              onTap: () async {
                final t = await showTimePicker(
                  context: context,
                  initialTime: _opens,
                );
                if (t != null) setState(() => _opens = t);
              },
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.captureHoursCloses),
              trailing: Text(_closes.format(context)),
              onTap: () async {
                final t = await showTimePicker(
                  context: context,
                  initialTime: _closes,
                );
                if (t != null) setState(() => _closes = t);
              },
            ),
            FilledButton(
              onPressed: _days.isEmpty || _hm(_opens) == _hm(_closes)
                  ? null
                  : () => Navigator.of(context).pop([
                      for (final d in (_days.toList()..sort()))
                        {
                          'day': d,
                          'opens': _hm(_opens),
                          'closes': _hm(_closes),
                        },
                    ]),
              child: Text(l10n.captureSave),
            ),
          ],
        ),
      ),
    );
  }
}
