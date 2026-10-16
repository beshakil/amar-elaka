import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/info_engine_providers.dart';
import '../application/info_providers.dart';
import '../data/info_engine_api.dart';
import 'info_engine_labels.dart';
import 'info_engine_screens.dart' show showInfoReportSheet;
import 'info_labels.dart';
import 'info_list_screen.dart';

const _itemTypes = [
  'person',
  'pet',
  'livestock',
  'phone',
  'wallet',
  'documents',
  'bag',
  'jewellery',
  'vehicle',
  'other',
];

class LostFoundScreen extends ConsumerWidget {
  const LostFoundScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return InfoListScreen(
      title: l10n.infoHubLostFoundTitle,
      path: '/info/lost-found',
      emptyIcon: Icons.travel_explore,
      filters: [
        (label: l10n.lfTabLost, query: const {'kind': 'lost'}),
        (label: l10n.lfTabFound, query: const {'kind': 'found'}),
      ],
      action: (
        label: l10n.lfNew,
        icon: Icons.add,
        onPressed: () => ref.read(isSignedInProvider)
            ? context.push(RoutePaths.lostFoundNew)
            : context.push(RoutePaths.login),
      ),
    );
  }
}

class LostFoundDetailScreen extends ConsumerStatefulWidget {
  const LostFoundDetailScreen({required this.id, super.key});

  final String id;

  @override
  ConsumerState<LostFoundDetailScreen> createState() =>
      _LostFoundDetailScreenState();
}

class _LostFoundDetailScreenState extends ConsumerState<LostFoundDetailScreen> {
  bool _busy = false;

  Future<void> _contact(String channel) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    if (!ref.read(isSignedInProvider)) {
      context.push(RoutePaths.login);
      return;
    }
    setState(() => _busy = true);
    try {
      final href = await ref
          .read(infoEngineApiProvider)
          .contactLostFound(widget.id, channel);
      await ref.read(externalAppsProvider).open(Uri.parse(href));
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.bloodContactFailed)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resolve() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await ref.read(infoEngineApiProvider).resolveLostFound(widget.id);
      ref
        ..invalidate(lostFoundDetailProvider(widget.id))
        ..invalidate(infoListProvider);
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.errorGenericMessage)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final detail = ref.watch(lostFoundDetailProvider(widget.id));
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.infoTypeLostFound),
        actions: [
          IconButton(
            icon: const Icon(Icons.flag_outlined),
            tooltip: l10n.infoReport,
            onPressed: () => ref.read(isSignedInProvider)
                ? showInfoReportSheet(
                    context,
                    ref,
                    kind: 'lost-found',
                    id: widget.id,
                  )
                : context.push(RoutePaths.login),
          ),
        ],
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(lostFoundDetailProvider(widget.id)),
        ),
        data: (d) => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            if (d.photos.isNotEmpty)
              SizedBox(
                height: 240,
                child: PageView(
                  children: [
                    for (final p in d.photos)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(AppSpacing.sm),
                        child: NetworkPhoto(url: p.url, decodeWidth: 480),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.xs,
              children: [
                for (final b in [d.kind, d.itemType])
                  if (InfoEngineLabels.badge(b, l10n) case final label?)
                    Chip(label: Text(label)),
              ],
            ),
            Text(
              d.card.title.of(locale) ?? '',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (d.lastSeenAt case final at?)
              Text(l10n.lfLastSeenAt(InfoLabels.moment(at, locale))),
            if (d.locationText case final where?) Text(where),
            if (d.description case final desc?) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(desc),
            ],
            if (d.reward case final r?)
              Text(
                l10n.lfReward('৳ ${formatMoney(r, locale)}'),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            if (d.card.lat != null)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton.icon(
                  icon: const Icon(Icons.place_outlined),
                  label: Text(l10n.infoOpenMap),
                  onPressed: () => ref
                      .read(externalAppsProvider)
                      .open(
                        Uri.parse(
                          'geo:${d.card.lat},${d.card.lng}?q=${d.card.lat},${d.card.lng}',
                        ),
                      ),
                ),
              ),
            const SizedBox(height: AppSpacing.md),
            if (d.status == 'pending_review')
              Text(l10n.lfPending)
            else if (d.status == 'resolved')
              Text(l10n.lfResolved)
            else if (d.isMine)
              AppButton(
                label: l10n.lfResolve,
                icon: Icons.check,
                isLoading: _busy,
                onPressed: _resolve,
              )
            else ...[
              AppButton(
                label: l10n.lfContact,
                icon: Icons.call,
                isLoading: _busy,
                onPressed: () => _contact('call'),
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.detailSendSms,
                icon: Icons.sms_outlined,
                variant: AppButtonVariant.secondary,
                onPressed: _busy ? null : () => _contact('sms'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Report lost or found: kind, what, where and when, photos. A moderator
/// reviews it first; the number is never listed.
class LostFoundNewScreen extends ConsumerStatefulWidget {
  const LostFoundNewScreen({super.key, this.picker});

  final ImagePicker? picker;

  @override
  ConsumerState<LostFoundNewScreen> createState() => _LostFoundNewScreenState();
}

class _LostFoundNewScreenState extends ConsumerState<LostFoundNewScreen> {
  String _kind = 'lost';
  String _type = 'pet';
  final _title = TextEditingController();
  final _description = TextEditingController();
  final _where = TextEditingController();
  final _reward = TextEditingController();
  DateTime? _lastSeen;
  bool _withLocation = false;
  final _photos = <File>[];
  bool _saving = false;

  // settings-exempt-style client cap; the API enforces lost_found_photos_max.
  static const _photoCap = 4;

  @override
  void dispose() {
    for (final c in [_title, _description, _where, _reward]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _addPhoto() async {
    final picked = await (widget.picker ?? ImagePicker()).pickImage(
      source: ImageSource.gallery,
      maxWidth: 1600,
      imageQuality: 85,
    );
    if (picked != null) setState(() => _photos.add(File(picked.path)));
  }

  Future<void> _pickLastSeen() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      firstDate: now.subtract(const Duration(days: 60)),
      lastDate: now,
      initialDate: now,
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(now),
    );
    setState(
      () => _lastSeen = DateTime(
        date.year,
        date.month,
        date.day,
        time?.hour ?? 0,
        time?.minute ?? 0,
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      final api = ref.read(infoEngineApiProvider);
      final ids = [for (final f in _photos) await api.uploadPhoto(f)];
      final origin = _withLocation
          ? await ref.read(viewerOriginProvider.future)
          : null;
      final reward = parseMoneyInput(_reward.text);
      String? opt(TextEditingController c) =>
          c.text.trim().isEmpty ? null : c.text.trim();
      await api.createLostFound({
        'kind': _kind,
        'itemType': _type,
        'title': _title.text.trim(),
        'description': ?opt(_description),
        'locationText': ?opt(_where),
        if (origin != null) 'location': {'lat': origin.lat, 'lng': origin.lng},
        if (_lastSeen != null)
          'lastSeenAt': _lastSeen!.toUtc().toIso8601String(),
        'reward': ?reward,
        'photoIds': ids,
      });
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.infoSubmittedForReview)),
      );
      if (mounted) context.pop();
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.errorGenericMessage)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.lfNew)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          SegmentedButton<String>(
            segments: [
              ButtonSegment(value: 'lost', label: Text(l10n.lfTabLost)),
              ButtonSegment(value: 'found', label: Text(l10n.lfTabFound)),
            ],
            selected: {_kind},
            onSelectionChanged: (s) => setState(() => _kind = s.first),
          ),
          DropdownButtonFormField<String>(
            initialValue: _type,
            decoration: InputDecoration(labelText: l10n.lfItemType),
            items: [
              for (final t in _itemTypes)
                DropdownMenuItem(
                  value: t,
                  child: Text(InfoEngineLabels.badge(t, l10n) ?? t),
                ),
            ],
            onChanged: (t) => setState(() => _type = t ?? 'other'),
          ),
          if (_type == 'person')
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
              child: Text(
                l10n.lfPersonNote,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          TextField(
            controller: _title,
            decoration: InputDecoration(labelText: l10n.lfTitle),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            controller: _description,
            decoration: InputDecoration(labelText: l10n.lfDescription),
            maxLines: 3,
          ),
          TextField(
            controller: _where,
            decoration: InputDecoration(labelText: l10n.lfWhere),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.lfLastSeenPick),
            subtitle: Text(
              _lastSeen == null ? '—' : InfoLabels.moment(_lastSeen!, locale),
            ),
            trailing: const Icon(Icons.schedule),
            onTap: _pickLastSeen,
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.lfUseMyLocation),
            value: _withLocation,
            onChanged: (v) => setState(() => _withLocation = v),
          ),
          TextField(
            controller: _reward,
            decoration: InputDecoration(labelText: l10n.lfRewardField),
            keyboardType: TextInputType.number,
          ),
          const SizedBox(height: AppSpacing.sm),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              for (final (i, f) in _photos.indexed)
                Stack(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(AppSpacing.xs),
                      child: Image.file(
                        f,
                        width: 80,
                        height: 80,
                        fit: BoxFit.cover,
                      ),
                    ),
                    Positioned(
                      right: 0,
                      top: 0,
                      child: InkWell(
                        onTap: () => setState(() => _photos.removeAt(i)),
                        child: const Icon(Icons.cancel, size: 20),
                      ),
                    ),
                  ],
                ),
              if (_photos.length < _photoCap)
                OutlinedButton.icon(
                  onPressed: _addPhoto,
                  icon: const Icon(Icons.add_a_photo_outlined),
                  label: Text(l10n.lfAddPhoto),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(l10n.lfPhoneNote, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          AppButton(
            label: l10n.infoSubmit,
            isLoading: _saving,
            onPressed: _title.text.trim().isEmpty ? null : _submit,
          ),
        ],
      ),
    );
  }
}
