import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/application/feed_controller.dart';
import '../application/info_engine_providers.dart';
import '../application/info_providers.dart';
import '../data/info_engine_api.dart';
import '../data/info_engine_models.dart';
import 'info_engine_labels.dart';
import 'info_labels.dart';
import 'info_list_screen.dart';

// ---- shared bits ---------------------------------------------------------------

/// "Report this": a reason, then POST …/report (the engine's one moderation path).
Future<void> showInfoReportSheet(
  BuildContext context,
  WidgetRef ref, {
  required String kind,
  required String id,
}) async {
  final l10n = AppLocalizations.of(context)!;
  final messenger = ScaffoldMessenger.of(context);
  final reason = await showModalBottomSheet<String>(
    context: context,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final code in const [
            'false_information',
            'privacy_risk',
            'spam',
            'harassment',
            'other',
          ])
            ListTile(
              title: Text(InfoEngineLabels.reportReason(code, l10n)),
              onTap: () => Navigator.pop(context, code),
            ),
        ],
      ),
    ),
  );
  if (reason == null) return;
  try {
    await ref.read(infoEngineApiProvider).report(kind, id, reason);
    messenger.showSnackBar(SnackBar(content: Text(l10n.infoReported)));
  } on AppException {
    messenger.showSnackBar(SnackBar(content: Text(l10n.errorGenericMessage)));
  }
}

Widget _section(BuildContext context, String title, List<Widget> children) =>
    Padding(
      padding: const EdgeInsets.only(top: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AppSpacing.xs),
          ...children,
        ],
      ),
    );

Widget _staleBanner(BuildContext context, String text) {
  final colors = Theme.of(context).colorScheme;
  return Container(
    margin: const EdgeInsets.only(top: AppSpacing.sm),
    padding: const EdgeInsets.all(AppSpacing.sm),
    decoration: BoxDecoration(
      color: colors.tertiaryContainer,
      borderRadius: BorderRadius.circular(AppSpacing.sm),
    ),
    child: Row(
      children: [
        Icon(Icons.history, color: colors.onTertiaryContainer),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(
            text,
            style: TextStyle(color: colors.onTertiaryContainer),
          ),
        ),
      ],
    ),
  );
}

// ---- outages --------------------------------------------------------------------

class OutagesScreen extends ConsumerWidget {
  const OutagesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return InfoListScreen(
      title: l10n.infoHubOutagesTitle,
      path: '/info/outages',
      emptyIcon: Icons.power_outlined,
      header: const _OutageReportCard(),
    );
  }
}

/// "No power / gas / water here now?" — counts once enough neighbours agree.
class _OutageReportCard extends ConsumerStatefulWidget {
  const _OutageReportCard();

  @override
  ConsumerState<_OutageReportCard> createState() => _OutageReportCardState();
}

class _OutageReportCardState extends ConsumerState<_OutageReportCard> {
  String _utility = 'electricity';
  bool _busy = false;

  Future<void> _report() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    if (!ref.read(isSignedInProvider)) {
      context.push(RoutePaths.login);
      return;
    }
    setState(() => _busy = true);
    try {
      final origin = await ref.read(infoOriginProvider.future);
      final r = await ref
          .read(infoEngineApiProvider)
          .reportOutage(_utility, origin);
      final locale = mounted
          ? Localizations.localeOf(context).languageCode
          : 'bn';
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            r.shown
                ? l10n.outageReportShown
                : l10n.outageReportThanks(
                    localizeDigits('${r.reporters}', locale),
                    localizeDigits('${r.threshold}', locale),
                  ),
          ),
        ),
      );
      ref.invalidate(infoListProvider);
    } on AppException {
      messenger.showSnackBar(SnackBar(content: Text(l10n.errorGenericMessage)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.outageReportTitle,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: AppSpacing.xs),
            Wrap(
              spacing: AppSpacing.xs,
              children: [
                for (final u in const ['electricity', 'gas', 'water'])
                  ChoiceChip(
                    label: Text(InfoEngineLabels.badge(u, l10n) ?? u),
                    selected: u == _utility,
                    onSelected: (_) => setState(() => _utility = u),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            AppButton(
              label: l10n.outageReportAction,
              icon: Icons.campaign_outlined,
              isLoading: _busy,
              onPressed: _report,
            ),
          ],
        ),
      ),
    );
  }
}

// ---- notices ---------------------------------------------------------------------

class NoticesScreen extends ConsumerWidget {
  const NoticesScreen({super.key, this.category});

  /// local | community | advisory (the tab it opens on).
  final String? category;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final tabs = <InfoFilter>[
      (label: l10n.noticeTabLocal, query: {'category': 'local'}),
      (label: l10n.noticeTabCommunity, query: {'category': 'community'}),
      (label: l10n.noticeTabAdvisory, query: {'category': 'advisory'}),
    ];
    final ordered = category == null
        ? tabs
        : [
            ...tabs.where((t) => t.query['category'] == category),
            ...tabs.where((t) => t.query['category'] != category),
          ];
    return InfoListScreen(
      title: category == 'community'
          ? l10n.infoHubCommunityTitle
          : category == 'advisory'
          ? l10n.agriAdvisories
          : l10n.infoHubNoticesTitle,
      path: '/info/notices',
      filters: ordered,
      emptyIcon: Icons.campaign_outlined,
      action: (
        label: l10n.noticeNew,
        icon: Icons.edit_outlined,
        onPressed: () => ref.read(isSignedInProvider)
            ? context.push(RoutePaths.noticeNew)
            : context.push(RoutePaths.login),
      ),
    );
  }
}

class NoticeDetailScreen extends ConsumerWidget {
  const NoticeDetailScreen({required this.id, super.key});

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final detail = ref.watch(noticeDetailProvider(id));
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.infoTypeNotice),
        actions: [
          IconButton(
            icon: const Icon(Icons.flag_outlined),
            tooltip: l10n.infoReport,
            onPressed: () => ref.read(isSignedInProvider)
                ? showInfoReportSheet(context, ref, kind: 'notices', id: id)
                : context.push(RoutePaths.login),
          ),
        ],
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(noticeDetailProvider(id)),
        ),
        data: (n) => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Wrap(
              spacing: AppSpacing.xs,
              children: [
                for (final b in n.card.badges)
                  if (InfoEngineLabels.badge(b, l10n) case final label?)
                    Chip(label: Text(label)),
              ],
            ),
            Text(
              n.card.title.of(locale) ?? '',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (n.template != null) _TemplateBlock(notice: n),
            const SizedBox(height: AppSpacing.sm),
            SelectableText(n.body),
            if (n.issuerName case final issuer?) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(
                l10n.noticeIssuer(issuer),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            if (n.expiresAt case final until?)
              Text(
                l10n.noticeValidUntil(InfoLabels.moment(until, locale)),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            if (n.attachments.isNotEmpty)
              _section(context, l10n.noticeAttachments, [
                for (final a in n.attachments)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      a.isImage
                          ? Icons.image_outlined
                          : Icons.picture_as_pdf_outlined,
                    ),
                    title: Text(a.mimeType),
                    trailing: TextButton(
                      onPressed: () =>
                          ref.read(externalAppsProvider).open(Uri.parse(a.url)),
                      child: Text(l10n.noticeOpenAttachment),
                    ),
                  ),
              ]),
          ],
        ),
      ),
    );
  }
}

/// The respectful janaza / condolence wording: the app's, never the poster's.
class _TemplateBlock extends StatelessWidget {
  const _TemplateBlock({required this.notice});

  final NoticeDetail notice;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final f = notice.templateFields;
    final name = '${f['deceasedName'] ?? ''}';
    final age = f['age'];
    final janazaAt = f['janazaAt'] is String
        ? DateTime.tryParse(f['janazaAt'] as String)
        : null;
    final janazaPlace = f['janazaPlace'] as String?;
    final burial = f['burialPlace'] as String?;
    final relation = f['relation'] as String?;
    final text = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(AppSpacing.sm),
      ),
      child: Column(
        children: [
          Text(
            l10n.noticeInnaLillahi,
            textAlign: TextAlign.center,
            style: text.titleMedium,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            age is num
                ? l10n.noticeJanazaPassedAge(
                    name,
                    localizeDigits('$age', locale),
                  )
                : l10n.noticeJanazaPassed(name),
            textAlign: TextAlign.center,
          ),
          if (relation != null && relation.isNotEmpty)
            Text(relation, textAlign: TextAlign.center),
          if (notice.template == 'janaza' &&
              (janazaAt != null || janazaPlace != null))
            Text(
              l10n.noticeJanazaAt(
                janazaAt == null ? '' : InfoLabels.moment(janazaAt, locale),
                janazaPlace == null
                    ? ''
                    : (janazaAt == null ? janazaPlace : ', $janazaPlace'),
              ),
              textAlign: TextAlign.center,
            ),
          if (burial != null && burial.isNotEmpty)
            Text(l10n.noticeBurialAt(burial), textAlign: TextAlign.center),
          if (notice.template == 'condolence') ...[
            const SizedBox(height: AppSpacing.xs),
            Text(l10n.noticeCondolenceLine, textAlign: TextAlign.center),
          ],
        ],
      ),
    );
  }
}

/// A member's community notice: janaza, condolence or an event. It waits for a moderator.
class NoticeNewScreen extends ConsumerStatefulWidget {
  const NoticeNewScreen({super.key});

  @override
  ConsumerState<NoticeNewScreen> createState() => _NoticeNewScreenState();
}

class _NoticeNewScreenState extends ConsumerState<NoticeNewScreen> {
  String _kind = 'janaza';
  final _title = TextEditingController();
  final _body = TextEditingController();
  final _name = TextEditingController();
  final _age = TextEditingController();
  final _relation = TextEditingController();
  final _janazaPlace = TextEditingController();
  final _burialPlace = TextEditingController();
  DateTime? _janazaAt;
  bool _saving = false;

  @override
  void dispose() {
    for (final c in [
      _title,
      _body,
      _name,
      _age,
      _relation,
      _janazaPlace,
      _burialPlace,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _templated => _kind != 'community';

  bool get _valid =>
      _title.text.trim().isNotEmpty &&
      _body.text.trim().isNotEmpty &&
      (!_templated || _name.text.trim().isNotEmpty);

  Future<void> _pickTime() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      firstDate: now.subtract(const Duration(days: 1)),
      lastDate: now.add(const Duration(days: 7)),
      initialDate: now,
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(now),
    );
    if (time == null) return;
    setState(
      () => _janazaAt = DateTime(
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
      final age = int.tryParse(toLatinDigits(_age.text.trim()));
      String? opt(TextEditingController c) =>
          c.text.trim().isEmpty ? null : c.text.trim();
      await ref.read(infoEngineApiProvider).createNotice({
        'type': _templated ? 'obituary' : 'community_event',
        'title': _title.text.trim(),
        'body': _body.text.trim(),
        if (_templated) 'template': _kind,
        if (_templated)
          'templateFields': {
            'deceasedName': _name.text.trim(),
            'age': ?age,
            'relation': ?opt(_relation),
            if (_kind == 'janaza' && _janazaAt != null)
              'janazaAt': _janazaAt!.toUtc().toIso8601String(),
            if (_kind == 'janaza') 'janazaPlace': ?opt(_janazaPlace),
            if (_kind == 'janaza') 'burialPlace': ?opt(_burialPlace),
          },
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
    InputDecoration d(String label) => InputDecoration(labelText: label);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.noticeNew)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          SegmentedButton<String>(
            segments: [
              ButtonSegment(
                value: 'janaza',
                label: Text(l10n.noticeKindJanaza),
              ),
              ButtonSegment(
                value: 'condolence',
                label: Text(l10n.noticeKindCondolence),
              ),
              ButtonSegment(
                value: 'community',
                label: Text(l10n.noticeKindCommunity),
              ),
            ],
            selected: {_kind},
            onSelectionChanged: (s) => setState(() => _kind = s.first),
          ),
          const SizedBox(height: AppSpacing.sm),
          if (_templated) ...[
            TextField(
              controller: _name,
              decoration: d(l10n.noticeDeceasedName),
              onChanged: (_) => setState(() {}),
            ),
            TextField(
              controller: _age,
              decoration: d(l10n.noticeAge),
              keyboardType: TextInputType.number,
            ),
            TextField(
              controller: _relation,
              decoration: d(l10n.noticeRelation),
            ),
          ],
          if (_kind == 'janaza') ...[
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.noticeJanazaTime),
              subtitle: Text(
                _janazaAt == null ? '—' : InfoLabels.moment(_janazaAt!, locale),
              ),
              trailing: const Icon(Icons.schedule),
              onTap: _pickTime,
            ),
            TextField(
              controller: _janazaPlace,
              decoration: d(l10n.noticeJanazaPlace),
            ),
            TextField(
              controller: _burialPlace,
              decoration: d(l10n.noticeBurialPlace),
            ),
          ],
          TextField(
            controller: _title,
            decoration: d(l10n.noticeFormTitle),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            controller: _body,
            decoration: d(l10n.noticeFormBody),
            maxLines: 4,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.md),
          AppButton(
            label: l10n.infoSubmit,
            isLoading: _saving,
            onPressed: _valid ? _submit : null,
          ),
        ],
      ),
    );
  }
}

// ---- transport ---------------------------------------------------------------------

class TransportScreen extends ConsumerWidget {
  const TransportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return InfoListScreen(
      title: l10n.infoHubTransportTitle,
      path: '/info/transport/routes',
      emptyIcon: Icons.directions_bus_outlined,
      filters: [
        (label: l10n.trAllModes, query: const {}),
        for (final m in const ['bus', 'train', 'launch', 'ferry', 'cng_stand'])
          (label: InfoEngineLabels.badge(m, l10n) ?? m, query: {'mode': m}),
      ],
    );
  }
}

class RouteDetailScreen extends ConsumerWidget {
  const RouteDetailScreen({required this.id, super.key});

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final detail = ref.watch(routeDetailProvider(id));
    String hm(DateTime at) =>
        localizeDigits(DateFormat.jm(locale).format(at.toLocal()), locale);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.infoTypeTransport)),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(routeDetailProvider(id)),
        ),
        data: (r) => RefreshIndicator(
          onRefresh: () => ref.refresh(routeDetailProvider(id).future),
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Text(
                r.card.title.of(locale) ?? '',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text('${r.originName} → ${r.destinationName}'),
              if (r.operatorName case final op?) Text(l10n.trOperator(op)),
              if (r.typicalDurationMinutes case final m?)
                Text(l10n.trDuration(localizeDigits('$m', locale))),
              if (r.fareMin != null || r.fareMax != null)
                Text(
                  l10n.trFare(
                    r.fareMin != null &&
                            r.fareMax != null &&
                            r.fareMin != r.fareMax
                        ? l10n.feedBazarRange(
                            formatMoney(r.fareMin!, locale),
                            formatMoney(r.fareMax!, locale),
                          )
                        : '৳ ${formatMoney((r.fareMin ?? r.fareMax)!, locale)}',
                  ),
                ),
              if (r.fareUpdatedOn case final d?)
                Text(l10n.trFareUpdated(InfoLabels.day(d, locale))),
              if (r.card.isStale) _staleBanner(context, l10n.infoStale),
              _section(context, l10n.trNext, [
                if (r.next.isEmpty) Text(l10n.trNoNext),
                for (final d in r.next)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.schedule),
                    title: Text(
                      hm(d.at),
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    subtitle: Text(
                      [
                        d.direction == 'return'
                            ? l10n.trDirReturn
                            : l10n.trDirOutbound,
                        ?d.serviceClass,
                        if (d.fare case final f?) '৳ ${formatMoney(f, locale)}',
                      ].join(' · '),
                    ),
                  ),
              ]),
              if (r.stops.isNotEmpty)
                _section(context, l10n.trStops, [
                  for (final s in r.stops)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(
                        radius: 12,
                        child: Text(localizeDigits('${s.seq}', locale)),
                      ),
                      title: Text(s.name.of(locale) ?? ''),
                      trailing: s.minutesFromOrigin == null
                          ? null
                          : Text(
                              l10n.trMinutesFrom(
                                localizeDigits(
                                  '${s.minutesFromOrigin}',
                                  locale,
                                ),
                              ),
                            ),
                    ),
                ]),
              if (r.schedules.isNotEmpty)
                _section(context, l10n.trTimetable, [
                  Wrap(
                    spacing: AppSpacing.xs,
                    runSpacing: AppSpacing.xs,
                    children: [
                      for (final s in r.schedules)
                        Chip(
                          label: Text(
                            '${localizeDigits(s.departureTime, locale)}'
                            '${s.direction == 'return' ? ' · ${l10n.trDirReturn}' : ''}',
                          ),
                        ),
                    ],
                  ),
                ]),
              if (r.contactPhones.isNotEmpty)
                _section(context, l10n.trCounter, [
                  for (final p in r.contactPhones)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.call),
                      title: Text(localizeDigits(p, locale)),
                      onTap: () => ref
                          .read(externalAppsProvider)
                          .open(Uri(scheme: 'tel', path: p)),
                    ),
                ]),
              if (r.notes case final n?) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(n),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ---- government service guide ---------------------------------------------------------

class GovServicesScreen extends ConsumerWidget {
  const GovServicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return InfoListScreen(
      title: l10n.infoHubGovTitle,
      path: '/info/gov-services',
      emptyIcon: Icons.account_balance_outlined,
      filters: [
        (label: l10n.govAllCategories, query: const {}),
        for (final c in const [
          'identity',
          'certificate',
          'land',
          'license',
          'social_safety',
          'agriculture',
          'health',
        ])
          (label: InfoEngineLabels.badge(c, l10n) ?? c, query: {'category': c}),
      ],
    );
  }
}

class GovServiceDetailScreen extends ConsumerStatefulWidget {
  const GovServiceDetailScreen({required this.slugOrId, super.key});

  final String slugOrId;

  @override
  ConsumerState<GovServiceDetailScreen> createState() =>
      _GovServiceDetailScreenState();
}

class _GovServiceDetailScreenState
    extends ConsumerState<GovServiceDetailScreen> {
  /// The documents the person already has (a checklist on this phone only).
  final _have = <int>{};
  int? _viewing;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final detail = ref.watch(govDetailProvider(widget.slugOrId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.infoTypeGovService)),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(govDetailProvider(widget.slugOrId)),
        ),
        data: (g) {
          final old = _viewing == null
              ? null
              : ref.watch(govVersionProvider((slug: g.slug, no: _viewing!)));
          final v = old?.value ?? g.current;
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              if (_viewing != null) _staleBanner(context, l10n.govViewingOld),
              Text(
                v.name.of(locale) ?? '',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              if (v.summary case final s?) Text(s),
              Text(
                l10n.govVerified(InfoLabels.day(g.lastVerifiedOn, locale)),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (g.card.isStale) _staleBanner(context, l10n.infoStale),
              _section(context, l10n.govOffice, [
                Text(
                  v.officeName,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                if (v.address case final a?) Text(a),
                if (v.hours case final h?) Text('${l10n.govHours}: $h'),
                if (v.officePlaceId != null || v.location != null)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: TextButton.icon(
                      icon: const Icon(Icons.place_outlined),
                      label: Text(l10n.infoOpenMap),
                      onPressed: () {
                        if (v.officePlaceId != null) {
                          context.push(RoutePaths.placeFor(v.officePlaceId!));
                        } else {
                          final p = v.location!;
                          ref
                              .read(externalAppsProvider)
                              .open(
                                Uri.parse(
                                  'geo:${p.lat},${p.lng}?q=${p.lat},${p.lng}',
                                ),
                              );
                        }
                      },
                    ),
                  ),
              ]),
              if (v.documents.isNotEmpty)
                _section(context, l10n.govDocuments, [
                  for (final (i, doc) in v.documents.indexed)
                    CheckboxListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      controlAffinity: ListTileControlAffinity.leading,
                      value: _have.contains(i),
                      title: Text(doc),
                      onChanged: (on) =>
                          setState(() => on! ? _have.add(i) : _have.remove(i)),
                    ),
                ]),
              if (v.fees.isNotEmpty)
                _section(context, l10n.govFees, [
                  for (final f in v.fees)
                    Row(
                      children: [
                        Expanded(child: Text(f.label)),
                        Text(
                          '৳ ${formatMoney(f.amount, locale)}',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                ]),
              if (v.steps.isNotEmpty)
                _section(context, l10n.govSteps, [
                  for (final (i, step) in v.steps.indexed)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(
                        radius: 12,
                        child: Text(localizeDigits('${i + 1}', locale)),
                      ),
                      title: Text(step),
                    ),
                ]),
              if (v.links.isNotEmpty)
                _section(context, l10n.govLinks, [
                  for (final link in v.links)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.open_in_new),
                      title: Text(link.label),
                      subtitle: Text(link.url),
                      onTap: () => ref
                          .read(externalAppsProvider)
                          .open(Uri.parse(link.url)),
                    ),
                ]),
              if (g.versions.length > 1)
                _section(context, l10n.govVersions, [
                  for (final ver in g.versions)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      selected:
                          (_viewing ?? g.current.versionNo) == ver.versionNo,
                      title: Text(
                        l10n.govVersionLabel(
                          localizeDigits('${ver.versionNo}', locale),
                          InfoLabels.moment(ver.createdAt, locale),
                        ),
                      ),
                      subtitle: ver.changeNote == null
                          ? null
                          : Text(ver.changeNote!),
                      onTap: () => setState(
                        () => _viewing = ver.versionNo == g.current.versionNo
                            ? null
                            : ver.versionNo,
                      ),
                    ),
                ]),
            ],
          );
        },
      ),
    );
  }
}

// ---- directories -----------------------------------------------------------------------

class DirectoryScreen extends ConsumerWidget {
  const DirectoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return InfoListScreen(
      title: l10n.infoHubDirectoryTitle,
      path: '/info/directory',
      emptyIcon: Icons.local_hospital_outlined,
      filters: [
        (label: l10n.dirTabHealth, query: const {'kind': 'health'}),
        (label: l10n.dirTabPharmacy, query: const {'kind': 'pharmacy'}),
        (
          label: '${l10n.dirTabPharmacy} · ${l10n.infoBadgeH24}',
          query: const {'kind': 'pharmacy', 'open24': 'true'},
        ),
        (label: l10n.dirTabEducation, query: const {'kind': 'education'}),
      ],
    );
  }
}

// ---- farming (rural areas) ------------------------------------------------------------------

class AgriScreen extends ConsumerWidget {
  const AgriScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final enabled = ref.watch(agriEnabledProvider);
    final isTeam = ref.watch(isAreaTeamProvider);
    Widget tile(IconData icon, String title, VoidCallback onTap) => Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        onTap: onTap,
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(
            icon,
            size: 32,
            color: Theme.of(context).colorScheme.primary,
          ),
          title: Text(title),
          trailing: const Icon(Icons.chevron_right),
        ),
      ),
    );
    return Scaffold(
      appBar: AppBar(title: Text(l10n.infoHubAgriTitle)),
      body: switch (enabled) {
        AsyncData(value: false) => Center(child: Text(l10n.agriDisabled)),
        AsyncData() => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            tile(
              Icons.grass_outlined,
              l10n.agriInputPrices,
              () => context.push('${RoutePaths.bazar}?board=agri'),
            ),
            if (isTeam)
              tile(
                Icons.edit_note,
                l10n.agriEntry,
                () => context.push('${RoutePaths.bazarEntry}?board=agri'),
              ),
            tile(
              Icons.cloud_outlined,
              l10n.agriAdvisories,
              () => context.push('${RoutePaths.notices}?category=advisory'),
            ),
            tile(Icons.agriculture_outlined, l10n.agriEquipment, () {
              // Rental listings are posts (the post system): the feed, filtered.
              ref
                  .read(feedControllerProvider.notifier)
                  .setCategory('agriculture');
              context.go(RoutePaths.home);
            }),
          ],
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}
