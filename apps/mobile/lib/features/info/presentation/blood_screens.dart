import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/presentation/listing_format.dart';
import '../../post/application/current_tenant.dart';
import '../application/info_providers.dart';
import '../data/info_api.dart';
import '../data/info_models.dart';
import 'info_labels.dart';

// ---- the hub ----------------------------------------------------------------

/// Blood donors and urgent requests (ADR 064): find a donor by group and
/// distance, the nearby requests, and one's own donor registration. Signed-
/// in members only — the list is health-adjacent personal data.
class BloodScreen extends ConsumerWidget {
  const BloodScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    if (!ref.watch(isSignedInProvider)) {
      return Scaffold(
        appBar: AppBar(title: Text(l10n.infoHubBloodTitle)),
        body: EmptyState(
          icon: Icons.bloodtype_outlined,
          title: l10n.bloodSignInPrompt,
          actionLabel: l10n.bloodSignIn,
          onAction: () => context.push(RoutePaths.login),
        ),
      );
    }
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(l10n.infoHubBloodTitle),
          bottom: TabBar(
            tabs: [
              Tab(text: l10n.bloodTabFind),
              Tab(text: l10n.bloodTabRequests),
              Tab(text: l10n.bloodTabMe),
            ],
          ),
        ),
        body: const TabBarView(
          children: [_FindTab(), _RequestsTab(), _MeTab()],
        ),
      ),
    );
  }
}

// ---- find a donor -------------------------------------------------------------

class _FindTab extends ConsumerStatefulWidget {
  const _FindTab();

  @override
  ConsumerState<_FindTab> createState() => _FindTabState();
}

class _FindTabState extends ConsumerState<_FindTab> {
  String _group = 'o_pos';
  bool _compatible = false;
  AsyncValue<DonorPage>? _result;

  Future<void> _search() async {
    setState(() => _result = const AsyncLoading());
    final result = await AsyncValue.guard(() async {
      final origin = await ref.read(viewerOriginProvider.future);
      return ref
          .read(infoApiProvider)
          .donors(
            group: _group,
            compatible: _compatible,
            lat: origin?.lat,
            lng: origin?.lng,
          );
    });
    if (mounted) setState(() => _result = result);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          l10n.bloodGroupLabel,
          style: Theme.of(context).textTheme.labelLarge,
        ),
        const SizedBox(height: AppSpacing.xs),
        _GroupPicker(
          value: _group,
          onChanged: (g) => setState(() => _group = g),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.bloodCompatible),
          value: _compatible,
          onChanged: (v) => setState(() => _compatible = v),
        ),
        AppButton(
          label: l10n.bloodSearch,
          icon: Icons.search,
          isLoading: _result is AsyncLoading,
          onPressed: _search,
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          l10n.bloodPrivacyNote,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        ...switch (_result) {
          null || AsyncLoading() => const <Widget>[],
          AsyncError() => [
            ErrorState(
              title: l10n.errorGenericTitle,
              retryLabel: l10n.genericRetry,
              onRetry: _search,
            ),
          ],
          AsyncData(:final value) when value.items.isEmpty => [
            EmptyState(
              title: l10n.bloodNoDonors,
              icon: Icons.bloodtype_outlined,
            ),
          ],
          AsyncData(:final value) => [
            for (final d in value.items) _DonorTile(donor: d),
          ],
        },
      ],
    );
  }
}

class _GroupPicker extends StatelessWidget {
  const _GroupPicker({required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: AppSpacing.xs,
    runSpacing: AppSpacing.xs,
    children: [
      for (final g in bloodGroups)
        ChoiceChip(
          label: Text(bloodGroupSymbol(g)),
          selected: g == value,
          onSelected: (_) => onChanged(g),
        ),
    ],
  );
}

class _DonorTile extends ConsumerStatefulWidget {
  const _DonorTile({required this.donor});

  final DonorCard donor;

  @override
  ConsumerState<_DonorTile> createState() => _DonorTileState();
}

class _DonorTileState extends ConsumerState<_DonorTile> {
  bool _busy = false;
  bool _asked = false;

  Future<void> _contact() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      // The caller's own open request, if any, so the donor sees the hospital.
      final mine = await ref
          .read(myRequestsProvider.future)
          .catchError((Object _) => <BloodRequestCard>[]);
      final open = mine.where((r) => r.status == 'open').firstOrNull;
      final outcome = await ref
          .read(infoApiProvider)
          .contactDonor(widget.donor.id, channel: 'call', requestId: open?.id);
      if (outcome.href case final href?) {
        await ref.read(externalAppsProvider).open(Uri.parse(href));
      } else {
        if (mounted) setState(() => _asked = true);
        messenger.showSnackBar(SnackBar(content: Text(l10n.bloodAskedDonor)));
      }
    } on AppException catch (e) {
      final reason = InfoLabels.refusalReason(e);
      final code = e is ApiException ? e.code : null;
      messenger.showSnackBar(
        SnackBar(
          content: Text(switch ((code, reason)) {
            (_, 'cap') || ('CONTACT_LIMIT_REACHED', _) => l10n.bloodContactCap,
            (_, 'unavailable') => l10n.bloodContactUnavailable,
            _ => l10n.bloodContactFailed,
          }),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final d = widget.donor;
    final details = [
      ?d.area?.of(locale),
      l10n.bloodDonorAway(
        ListingFormat.distance(d.distanceMeters, l10n, locale) ?? '',
      ),
      InfoLabels.contactWindow(d.contactWindow, l10n),
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: Theme.of(context).colorScheme.errorContainer,
              child: Text(
                bloodGroupSymbol(d.bloodGroup),
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onErrorContainer,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    d.displayName ?? l10n.bloodAnonymous,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(details, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
            if (_asked)
              const Icon(Icons.check_circle_outline)
            else
              TextButton.icon(
                onPressed: _busy ? null : _contact,
                icon: Icon(d.sharesNumber ? Icons.call : Icons.send_outlined),
                label: Text(
                  d.sharesNumber ? l10n.bloodCallDonor : l10n.bloodAskDonor,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ---- urgent requests ------------------------------------------------------------

class _RequestsTab extends ConsumerWidget {
  const _RequestsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final nearby = ref.watch(nearbyRequestsProvider);
    final mine = ref.watch(myRequestsProvider);
    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(nearbyRequestsProvider)
          ..invalidate(myRequestsProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          AppButton(
            label: l10n.bloodNewRequest,
            icon: Icons.add,
            onPressed: () => context.push(RoutePaths.bloodNewRequest),
          ),
          if (mine.value case final list? when list.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md),
            Text(
              l10n.bloodMyRequests,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: AppSpacing.xs),
            for (final r in list) _RequestTile(request: r),
          ],
          const SizedBox(height: AppSpacing.md),
          ...nearby.when(
            loading: () => [const Center(child: CircularProgressIndicator())],
            error: (_, _) => [
              ErrorState(
                title: l10n.errorGenericTitle,
                retryLabel: l10n.genericRetry,
                onRetry: () => ref.invalidate(nearbyRequestsProvider),
              ),
            ],
            data: (list) => list.where((r) => !r.isMine).isEmpty
                ? [
                    EmptyState(
                      title: l10n.bloodRequestsEmpty,
                      icon: Icons.bloodtype_outlined,
                    ),
                  ]
                : [
                    for (final r in list.where((r) => !r.isMine))
                      _RequestTile(request: r),
                  ],
          ),
        ],
      ),
    );
  }
}

class _RequestTile extends StatelessWidget {
  const _RequestTile({required this.request});

  final BloodRequestCard request;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    final r = request;
    final details = [
      l10n.bloodRequestUnits(localizeDigits('${r.units}', locale)),
      l10n.bloodRequestNeededBy(InfoLabels.moment(r.neededBy, locale)),
      ?ListingFormat.distance(r.distanceMeters, l10n, locale),
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        onTap: () => context.push(RoutePaths.bloodRequestFor(r.id)),
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: CircleAvatar(
            backgroundColor: colors.error,
            child: Text(
              bloodGroupSymbol(r.bloodGroup),
              style: TextStyle(
                color: colors.onError,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          title: Text(r.hospitalName),
          subtitle: Text(details),
          trailing: Text(
            r.status == 'open'
                ? InfoLabels.urgency(r.urgency, l10n)
                : InfoLabels.requestStatus(r.status, l10n),
            style: TextStyle(
              color: r.urgency == 'critical' && r.status == 'open'
                  ? colors.error
                  : colors.onSurfaceVariant,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

// ---- me as a donor ------------------------------------------------------------------

class _MeTab extends ConsumerWidget {
  const _MeTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final me = ref.watch(myDonorProvider);
    return me.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (_, _) => ErrorState(
        title: l10n.errorGenericTitle,
        retryLabel: l10n.genericRetry,
        onRetry: () => ref.invalidate(myDonorProvider),
      ),
      data: (donor) => donor == null
          ? EmptyState(
              icon: Icons.volunteer_activism_outlined,
              title: l10n.bloodMeNotDonor,
              actionLabel: l10n.bloodRegisterSubmit,
              onAction: () => context.push(RoutePaths.bloodRegister),
            )
          : _DonorStatus(donor: donor),
    );
  }
}

class _DonorStatus extends ConsumerStatefulWidget {
  const _DonorStatus({required this.donor});

  final MyDonor donor;

  @override
  ConsumerState<_DonorStatus> createState() => _DonorStatusState();
}

class _DonorStatusState extends ConsumerState<_DonorStatus> {
  bool _busy = false;

  Future<void> _run(Future<void> Function() action, {String? done}) async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context)!;
    setState(() => _busy = true);
    try {
      await action();
      ref.invalidate(myDonorProvider);
      if (done != null) messenger.showSnackBar(SnackBar(content: Text(done)));
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
    final colors = Theme.of(context).colorScheme;
    final d = widget.donor;
    final api = ref.read(infoApiProvider);
    final inGap = d.isAvailable && !d.isListed && d.eligibleFrom != null;
    final (statusText, statusColor) = switch ((d.isAvailable, d.isListed)) {
      (_, true) => (l10n.bloodMeListed, Colors.green.shade700),
      (false, _) => (l10n.bloodMePaused, colors.onSurfaceVariant),
      _ when inGap => (
        l10n.bloodMeGap(InfoLabels.day(d.eligibleFrom!, locale)),
        colors.tertiary,
      ),
      _ => (l10n.bloodMePaused, colors.onSurfaceVariant),
    };
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        AppCard(
          child: Row(
            children: [
              CircleAvatar(
                radius: 28,
                backgroundColor: colors.errorContainer,
                child: Text(
                  bloodGroupSymbol(d.bloodGroup),
                  style: TextStyle(
                    color: colors.onErrorContainer,
                    fontWeight: FontWeight.w700,
                    fontSize: 18,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      statusText,
                      style: TextStyle(
                        color: statusColor,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      l10n.bloodMeContactsToday(
                        localizeDigits('${d.contactsToday}', locale),
                        localizeDigits('${d.dailyContactCap}', locale),
                      ),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        SwitchListTile(
          title: Text(l10n.bloodMeAvailable),
          value: d.isAvailable,
          onChanged: _busy
              ? null
              : (v) => _run(() async => api.setAvailable(v)),
        ),
        ListTile(
          leading: const Icon(Icons.bloodtype),
          title: Text(l10n.bloodMeRecordDonation),
          enabled: !_busy,
          onTap: () => _run(
            () async => api.recordDonation(
              DateFormat('yyyy-MM-dd').format(DateTime.now()),
            ),
            done: l10n.bloodMeDonationRecorded,
          ),
        ),
        ListTile(
          leading: const Icon(Icons.people_outline),
          title: Text(l10n.bloodMeWhoContacted),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(RoutePaths.bloodContacts),
        ),
        ListTile(
          leading: const Icon(Icons.edit_outlined),
          title: Text(l10n.bloodMeEdit),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(RoutePaths.bloodRegister, extra: d),
        ),
        ListTile(
          leading: Icon(Icons.logout, color: colors.error),
          title: Text(
            l10n.bloodMeWithdraw,
            style: TextStyle(color: colors.error),
          ),
          enabled: !_busy,
          onTap: () async {
            final ok = await showDialog<bool>(
              context: context,
              builder: (context) => AlertDialog(
                content: Text(l10n.bloodMeWithdrawConfirm),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: Text(
                      MaterialLocalizations.of(context).cancelButtonLabel,
                    ),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: Text(
                      MaterialLocalizations.of(context).okButtonLabel,
                    ),
                  ),
                ],
              ),
            );
            if (ok ?? false) await _run(api.withdraw);
          },
        ),
      ],
    );
  }
}

// ---- register ------------------------------------------------------------------------

/// Opt in as a donor (or change one's details): group, when to be
/// contacted, whether the number is shared, alerts; consent and the
/// eligibility statement are required. The point is kept approximate.
class RegisterDonorScreen extends ConsumerStatefulWidget {
  const RegisterDonorScreen({super.key, this.existing});

  final MyDonor? existing;

  @override
  ConsumerState<RegisterDonorScreen> createState() =>
      _RegisterDonorScreenState();
}

class _RegisterDonorScreenState extends ConsumerState<RegisterDonorScreen> {
  late String _group = widget.existing?.bloodGroup ?? 'o_pos';
  late String _window = widget.existing?.contactWindow ?? 'any';
  late bool _share = widget.existing?.sharesNumber ?? false;
  late bool _alerts = widget.existing?.alertsEnabled ?? true;
  late String? _lastDonated = widget.existing?.lastDonatedOn;
  late bool _eligible = widget.existing != null;
  late bool _consent = widget.existing != null;
  bool _saving = false;

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(now.year - 5),
      lastDate: now,
      initialDate: now,
    );
    if (picked != null) {
      setState(() => _lastDonated = DateFormat('yyyy-MM-dd').format(picked));
    }
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      final origin =
          await ref.read(viewerOriginProvider.future) ??
          widget.existing?.location;
      if (origin == null) {
        messenger.showSnackBar(
          SnackBar(content: Text(l10n.bloodRegisterNeedLocation)),
        );
        return;
      }
      await ref
          .read(infoApiProvider)
          .registerDonor(
            bloodGroup: _group,
            lat: origin.lat,
            lng: origin.lng,
            contactWindow: _window,
            sharesNumber: _share,
            alertsEnabled: _alerts,
            lastDonatedOn: _lastDonated,
          );
      ref.invalidate(myDonorProvider);
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
      appBar: AppBar(title: Text(l10n.bloodRegisterTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            l10n.bloodGroupLabel,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.xs),
          _GroupPicker(
            value: _group,
            onChanged: (g) => setState(() => _group = g),
          ),
          const SizedBox(height: AppSpacing.md),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRegisterLastDonated),
            subtitle: Text(
              _lastDonated == null
                  ? l10n.bloodRegisterPickDate
                  : InfoLabels.day(_lastDonated!, locale),
            ),
            trailing: const Icon(Icons.calendar_today_outlined),
            onTap: _pickDate,
          ),
          DropdownButtonFormField<String>(
            initialValue: _window,
            decoration: InputDecoration(labelText: l10n.bloodRegisterWindow),
            items: [
              for (final w in contactWindows)
                DropdownMenuItem(
                  value: w,
                  child: Text(InfoLabels.contactWindow(w, l10n)),
                ),
            ],
            onChanged: (w) => setState(() => _window = w ?? 'any'),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRegisterShareNumber),
            subtitle: Text(l10n.bloodRegisterShareNumberHelp),
            value: _share,
            onChanged: (v) => setState(() => _share = v),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRegisterAlerts),
            value: _alerts,
            onChanged: (v) => setState(() => _alerts = v),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRegisterEligibility),
            value: _eligible,
            onChanged: (v) => setState(() => _eligible = v ?? false),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRegisterConsent),
            value: _consent,
            onChanged: (v) => setState(() => _consent = v ?? false),
          ),
          Text(
            l10n.bloodRegisterLocationNote,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
          AppButton(
            label: widget.existing == null
                ? l10n.bloodRegisterSubmit
                : l10n.bloodSave,
            isLoading: _saving,
            onPressed: _eligible && _consent ? _submit : null,
          ),
        ],
      ),
    );
  }
}

// ---- who contacted me ------------------------------------------------------------------

class DonorContactsScreen extends ConsumerWidget {
  const DonorContactsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final contacts = ref.watch(myDonorContactsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.bloodMeWhoContacted)),
      body: contacts.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(myDonorContactsProvider),
        ),
        data: (list) => list.isEmpty
            ? EmptyState(
                title: l10n.bloodContactsEmpty,
                icon: Icons.people_outline,
              )
            : ListView(
                padding: const EdgeInsets.all(AppSpacing.md),
                children: [
                  for (final c in list)
                    AppCard(
                      onTap: c.request == null
                          ? null
                          : () => context.push(
                              RoutePaths.bloodRequestFor(c.request!.id),
                            ),
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          c.channel == 'donor_request'
                              ? Icons.mark_email_unread_outlined
                              : Icons.call_received,
                        ),
                        title: Text(c.requesterName ?? l10n.bloodAnonymous),
                        subtitle: Text(
                          [
                            c.channel == 'donor_request'
                                ? l10n.bloodContactAsked
                                : l10n.bloodContactTookNumber,
                            InfoLabels.moment(c.at, locale),
                            if (c.request case final r?)
                              '${bloodGroupSymbol(r.bloodGroup)} · ${r.hospitalName}',
                          ].join(' · '),
                        ),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

// ---- a new urgent request ------------------------------------------------------------------

class NewBloodRequestScreen extends ConsumerStatefulWidget {
  const NewBloodRequestScreen({super.key});

  @override
  ConsumerState<NewBloodRequestScreen> createState() =>
      _NewBloodRequestScreenState();
}

class _NewBloodRequestScreenState extends ConsumerState<NewBloodRequestScreen> {
  String _group = 'o_pos';
  int _units = 1;
  String _urgency = 'urgent';
  // A sensible default the user changes: a few hours from now.
  DateTime _neededBy = DateTime.now().add(const Duration(hours: 6));
  final _hospital = TextEditingController();
  final _note = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _hospital.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickTime() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      firstDate: now,
      lastDate: now.add(const Duration(days: 7)),
      initialDate: _neededBy,
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_neededBy),
    );
    if (time == null) return;
    setState(
      () => _neededBy = DateTime(
        date.year,
        date.month,
        date.day,
        time.hour,
        time.minute,
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      final center = ref.read(currentTenantConfigProvider)?.mapCenter;
      final origin =
          await ref.read(viewerOriginProvider.future) ??
          (center == null ? null : (lat: center.lat, lng: center.lng));
      if (origin == null) {
        messenger.showSnackBar(
          SnackBar(content: Text(l10n.bloodRegisterNeedLocation)),
        );
        return;
      }
      final created = await ref
          .read(infoApiProvider)
          .createRequest(
            bloodGroup: _group,
            units: _units,
            hospitalName: _hospital.text.trim(),
            lat: origin.lat,
            lng: origin.lng,
            neededBy: _neededBy,
            urgency: _urgency,
            patientNote: _note.text,
          );
      ref
        ..invalidate(myRequestsProvider)
        ..invalidate(nearbyRequestsProvider);
      if (!mounted) return;
      final locale = Localizations.localeOf(context).languageCode;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            l10n.bloodRequestSent(localizeDigits('${created.alerted}', locale)),
          ),
        ),
      );
      context.pushReplacement(RoutePaths.bloodRequestFor(created.id));
    } on ApiException catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            e.code == 'BLOOD_REQUEST_REFUSED'
                ? l10n.bloodRequestRefused
                : l10n.errorGenericMessage,
          ),
        ),
      );
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.errorNetworkMessage)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.bloodNewRequest)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            l10n.bloodGroupLabel,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.xs),
          _GroupPicker(
            value: _group,
            onChanged: (g) => setState(() => _group = g),
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _hospital,
            decoration: InputDecoration(labelText: l10n.bloodRequestHospital),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(child: Text(l10n.bloodRequestUnitsLabel)),
              IconButton(
                icon: const Icon(Icons.remove_circle_outline),
                onPressed: _units > 1 ? () => setState(() => _units--) : null,
              ),
              Text(localizeDigits('$_units', locale)),
              IconButton(
                icon: const Icon(Icons.add_circle_outline),
                onPressed: () => setState(() => _units++),
              ),
            ],
          ),
          DropdownButtonFormField<String>(
            initialValue: _urgency,
            decoration: InputDecoration(labelText: l10n.bloodRequestUrgency),
            items: [
              for (final u in urgencyLevels)
                DropdownMenuItem(
                  value: u,
                  child: Text(InfoLabels.urgency(u, l10n)),
                ),
            ],
            onChanged: (u) => setState(() => _urgency = u ?? 'urgent'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(l10n.bloodRequestWhen),
            subtitle: Text(InfoLabels.moment(_neededBy, locale)),
            trailing: const Icon(Icons.schedule),
            onTap: _pickTime,
          ),
          TextField(
            controller: _note,
            maxLines: 2,
            decoration: InputDecoration(labelText: l10n.bloodRequestNote),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.bloodRequestLocationNote,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
          AppButton(
            label: l10n.bloodRequestSubmit,
            isLoading: _saving,
            onPressed: _hospital.text.trim().length >= 2 ? _submit : null,
          ),
        ],
      ),
    );
  }
}

// ---- one request -----------------------------------------------------------------------------

class BloodRequestScreen extends ConsumerStatefulWidget {
  const BloodRequestScreen({required this.requestId, super.key});

  final String requestId;

  @override
  ConsumerState<BloodRequestScreen> createState() => _BloodRequestScreenState();
}

class _BloodRequestScreenState extends ConsumerState<BloodRequestScreen> {
  bool _busy = false;

  Future<void> _contact(String channel) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final href = await ref
          .read(infoApiProvider)
          .contactRequester(widget.requestId, channel: channel);
      await ref.read(externalAppsProvider).open(Uri.parse(href));
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.bloodContactFailed)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _close(String outcome) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await ref.read(infoApiProvider).closeRequest(widget.requestId, outcome);
      ref
        ..invalidate(bloodRequestProvider(widget.requestId))
        ..invalidate(myRequestsProvider);
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
    final colors = Theme.of(context).colorScheme;
    final detail = ref.watch(bloodRequestProvider(widget.requestId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.bloodTabRequests)),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(bloodRequestProvider(widget.requestId)),
        ),
        data: (d) {
          final r = d.card;
          final open = r.status == 'open';
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 32,
                    backgroundColor: colors.error,
                    child: Text(
                      bloodGroupSymbol(r.bloodGroup),
                      style: TextStyle(
                        color: colors.onError,
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          r.hospitalName,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          '${InfoLabels.urgency(r.urgency, l10n)} · ${InfoLabels.requestStatus(r.status, l10n)}',
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.bloodRequestUnits(localizeDigits('${r.units}', locale)),
              ),
              Text(
                l10n.bloodRequestNeededBy(
                  InfoLabels.moment(r.neededBy, locale),
                ),
              ),
              if (d.requesterName case final name?)
                Text(l10n.bloodRequestRequester(name)),
              if (d.patientNote case final note?) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(note),
              ],
              if (d.alertedDonors case final n?) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(
                  l10n.bloodRequestAlerted(localizeDigits('$n', locale)),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: AppSpacing.lg),
              if (!open)
                Text(l10n.bloodRequestClosed)
              else if (r.isMine) ...[
                AppButton(
                  label: l10n.bloodRequestFulfilled,
                  icon: Icons.check,
                  isLoading: _busy,
                  onPressed: () => _close('fulfilled'),
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: l10n.bloodRequestCancel,
                  variant: AppButtonVariant.secondary,
                  onPressed: _busy ? null : () => _close('cancelled'),
                ),
              ] else ...[
                AppButton(
                  label: l10n.bloodCallDonor,
                  icon: Icons.call,
                  isLoading: _busy,
                  onPressed: () => _contact('call'),
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: l10n.bloodRequestContact,
                  icon: Icons.sms_outlined,
                  variant: AppButtonVariant.secondary,
                  onPressed: _busy ? null : () => _contact('sms'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}
