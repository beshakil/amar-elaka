import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/bazar_entry_form.dart';
import '../application/info_providers.dart';
import '../data/info_api.dart';
import '../data/info_models.dart';
import 'info_labels.dart';

/// The public price board (ADR 064): today vs yesterday with an arrow, the
/// trend, Bengali numerals, the sponsor, and a banner when today is missing.
class BazarBoardScreen extends ConsumerWidget {
  const BazarBoardScreen({super.key, this.board = 'bazar'});

  /// `bazar` or `agri` — the farm-input board is the same screen.
  final String board;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final prices = ref.watch(bazarBoardProvider(board));
    final isTeam = ref.watch(isAreaTeamProvider);
    final agri = board == 'agri';
    return Scaffold(
      appBar: AppBar(
        title: Text(agri ? l10n.agriInputPrices : l10n.infoHubBazarTitle),
        actions: [
          if (isTeam)
            IconButton(
              icon: const Icon(Icons.edit_note),
              tooltip: agri ? l10n.agriEntry : l10n.infoHubBazarEntry,
              onPressed: () => context.push(
                agri
                    ? '${RoutePaths.bazarEntry}?board=agri'
                    : RoutePaths.bazarEntry,
              ),
            ),
        ],
      ),
      body: prices.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ErrorState(
          title: l10n.errorGenericTitle,
          message: l10n.errorGenericMessage,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(bazarBoardProvider(board)),
        ),
        data: (b) => RefreshIndicator(
          onRefresh: () => ref.refresh(bazarBoardProvider(board).future),
          child: _Board(board: b),
        ),
      ),
    );
  }
}

class _Board extends StatelessWidget {
  const _Board({required this.board});

  final BazarBoard board;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    final groups = <String, List<BazarBoardItem>>{};
    for (final item in board.items) {
      (groups[item.group] ??= []).add(item);
    }
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        if (board.sponsor case final sponsor?)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Text(
              l10n.bazarSponsoredBy(sponsor.name.of(locale) ?? ''),
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: colors.primary),
            ),
          ),
        if (board.isStale)
          Container(
            margin: const EdgeInsets.only(bottom: AppSpacing.md),
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
                    board.lastUpdated == null
                        ? l10n.bazarNeverUpdated
                        : l10n.bazarStaleBanner(
                            InfoLabels.day(board.lastUpdated!, locale),
                          ),
                    style: TextStyle(color: colors.onTertiaryContainer),
                  ),
                ),
              ],
            ),
          ),
        for (final entry in groups.entries) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(
              InfoLabels.commodityGroup(entry.key, l10n),
              style: Theme.of(context).textTheme.titleSmall,
            ),
          ),
          for (final item in entry.value) _ItemRow(item: item),
        ],
      ],
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.item});

  final BazarBoardItem item;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final text = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    final shown = item.latest;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.name.of(locale) ?? item.code,
                    style: text.titleSmall,
                  ),
                  Text(
                    item.yesterday == null
                        ? '${l10n.bazarYesterday}: ${l10n.bazarNoPriceDash}'
                        : '${l10n.bazarYesterday}: ${InfoLabels.priceRange(item.yesterday!.min, item.yesterday!.max, item.unit, l10n, locale)}',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            _Sparkline(points: item.trend),
            const SizedBox(width: AppSpacing.sm),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  shown == null
                      ? l10n.bazarNoPriceDash
                      : InfoLabels.priceRange(
                          shown.min,
                          shown.max,
                          item.unit,
                          l10n,
                          locale,
                        ),
                  style: text.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                if (item.direction case final d?) _Arrow(direction: d),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Up is red (dearer), down is green (cheaper) — from the buyer's side.
class _Arrow extends StatelessWidget {
  const _Arrow({required this.direction});

  final PriceDirection direction;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final (icon, color, label) = switch (direction) {
      PriceDirection.up => (Icons.arrow_upward, colors.error, l10n.bazarUp),
      PriceDirection.down => (
        Icons.arrow_downward,
        Colors.green.shade700,
        l10n.bazarDown,
      ),
      PriceDirection.same => (
        Icons.remove,
        colors.onSurfaceVariant,
        l10n.bazarSame,
      ),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: color, semanticLabel: label),
        const SizedBox(width: AppSpacing.xxs),
        Text(label, style: TextStyle(color: color, fontSize: 12)),
      ],
    );
  }
}

/// The trend as a tiny line of mid-prices; gaps where nothing was entered.
class _Sparkline extends StatelessWidget {
  const _Sparkline({required this.points});

  final List<TrendPoint?> points;

  static const _size = Size(56, 24);

  @override
  Widget build(BuildContext context) {
    if (points.where((p) => p != null).length < 2) {
      return SizedBox.fromSize(size: _size);
    }
    return CustomPaint(
      size: _size,
      painter: _SparklinePainter(points, Theme.of(context).colorScheme.primary),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter(this.points, this.color);

  final List<TrendPoint?> points;
  final Color color;

  static int _mid(TrendPoint p) => _poisha(p.range.min) + _poisha(p.range.max);

  static int _poisha(String money) {
    final parts = money.split('.');
    return int.parse(parts[0]) * 100 +
        int.parse(parts.length > 1 ? parts[1].padRight(2, '0') : '0');
  }

  @override
  void paint(Canvas canvas, Size size) {
    final mids = [for (final p in points) p == null ? null : _mid(p)];
    final known = mids.whereType<int>();
    final lo = known.reduce((a, b) => a < b ? a : b);
    final hi = known.reduce((a, b) => a > b ? a : b);
    final span = (hi - lo) == 0 ? 1 : hi - lo;
    final step = size.width / (points.length - 1);
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;
    // One path per run of known days: a day with no price breaks the line.
    final path = Path();
    var drawing = false;
    for (var i = 0; i < mids.length; i++) {
      final m = mids[i];
      if (m == null) {
        drawing = false;
        continue;
      }
      final x = i * step;
      final y = size.height - (m - lo) / span * size.height;
      if (drawing) {
        path.lineTo(x, y);
      } else {
        path.moveTo(x, y);
        drawing = true;
      }
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_SparklinePainter old) => old.points != points;
}

/// The fast entry (ADR 064): one screen, every item with yesterday's figure
/// prefilled, one "publish" — built to take two minutes on a phone.
class BazarEntryScreen extends ConsumerStatefulWidget {
  const BazarEntryScreen({super.key, this.date, this.board = 'bazar'});

  final String? date;
  final String board;

  @override
  ConsumerState<BazarEntryScreen> createState() => _BazarEntryScreenState();
}

class _BazarEntryScreenState extends ConsumerState<BazarEntryScreen> {
  BazarEntryForm? _form;
  final _controllers = <TextEditingController>[];
  bool _saving = false;
  int _generation = 0;

  @override
  void dispose() {
    for (final c in _controllers) {
      c.dispose();
    }
    super.dispose();
  }

  void _bind(BazarEntrySheet sheet) {
    if (_form != null && identical(_form!.sheet, sheet)) return;
    final form = BazarEntryForm(sheet);
    for (final c in _controllers) {
      c.dispose();
    }
    _controllers.clear();
    final locale = Localizations.localeOf(context).languageCode;
    for (var i = 0; i < sheet.items.length; i++) {
      _controllers
        ..add(
          TextEditingController(text: localizeDigits(form.minAt(i), locale)),
        )
        ..add(
          TextEditingController(text: localizeDigits(form.maxAt(i), locale)),
        );
    }
    _form = form;
    _generation++;
  }

  void _copyPrevious() {
    final form = _form!;
    final locale = Localizations.localeOf(context).languageCode;
    setState(() {
      for (var i = 0; i < form.sheet.items.length; i++) {
        final prev = form.sheet.items[i].previous;
        if (prev == null) continue;
        final min = prev.min.endsWith('.00')
            ? prev.min.substring(0, prev.min.length - 3)
            : prev.min;
        final max = prev.max.endsWith('.00')
            ? prev.max.substring(0, prev.max.length - 3)
            : prev.max;
        form
          ..setMin(i, min)
          ..setMax(i, max);
        _controllers[i * 2].text = localizeDigits(min, locale);
        _controllers[i * 2 + 1].text = localizeDigits(max, locale);
      }
    });
  }

  Future<void> _save() async {
    final l10n = AppLocalizations.of(context)!;
    final form = _form!;
    final messenger = ScaffoldMessenger.of(context);
    if (form.firstInvalid != null) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.bazarEntryInvalid)));
      return;
    }
    final lines = form.lines();
    if (lines.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.bazarEntryNothing)));
      return;
    }
    setState(() => _saving = true);
    try {
      final saved = await ref
          .read(infoApiProvider)
          .saveBazarEntry(form.sheet.date, lines);
      ref.invalidate(bazarBoardProvider(widget.board));
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            l10n.bazarEntrySaved(
              localizeDigits(
                '$saved',
                Localizations.localeOf(context).languageCode,
              ),
            ),
          ),
        ),
      );
      context.pop();
    } on ApiException catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            e.statusCode == 403
                ? l10n.bazarEntryTeamOnly
                : l10n.bazarEntryRefused,
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
    final sheet = ref.watch(
      bazarEntryProvider((date: widget.date, board: widget.board)),
    );
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.board == 'agri' ? l10n.agriEntry : l10n.bazarEntryTitle,
        ),
      ),
      body: sheet.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorState(
          title: e is ApiException && e.statusCode == 403
              ? l10n.bazarEntryTeamOnly
              : l10n.errorGenericTitle,
          retryLabel: l10n.genericRetry,
          onRetry: () => ref.invalidate(
            bazarEntryProvider((date: widget.date, board: widget.board)),
          ),
        ),
        data: (s) {
          _bind(s);
          final form = _form!;
          if (s.items.isEmpty) {
            return EmptyState(title: l10n.bazarNeverUpdated);
          }
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.md,
                  AppSpacing.sm,
                  AppSpacing.md,
                  0,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        l10n.bazarEntryDate(InfoLabels.day(s.date, locale)),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ),
                    TextButton.icon(
                      onPressed: _copyPrevious,
                      icon: const Icon(Icons.content_copy, size: 18),
                      label: Text(l10n.bazarEntryCopyAll),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView.builder(
                  key: ValueKey(_generation),
                  padding: const EdgeInsets.all(AppSpacing.md),
                  itemCount: s.items.length,
                  itemBuilder: (context, i) => _EntryRow(
                    item: s.items[i],
                    minController: _controllers[i * 2],
                    maxController: _controllers[i * 2 + 1],
                    onMin: (v) => setState(() => form.setMin(i, v)),
                    onMax: (v) => setState(() => form.setMax(i, v)),
                    last: i == s.items.length - 1,
                  ),
                ),
              ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  child: SizedBox(
                    width: double.infinity,
                    child: AppButton(
                      label: l10n.bazarEntrySave(
                        localizeDigits('${form.filled}', locale),
                      ),
                      isLoading: _saving,
                      onPressed: _save,
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _EntryRow extends StatelessWidget {
  const _EntryRow({
    required this.item,
    required this.minController,
    required this.maxController,
    required this.onMin,
    required this.onMax,
    required this.last,
  });

  final BazarEntryItem item;
  final TextEditingController minController;
  final TextEditingController maxController;
  final ValueChanged<String> onMin;
  final ValueChanged<String> onMax;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final prev = item.previous;
    final formatters = [
      FilteringTextInputFormatter.allow(RegExp(r'[0-9০-৯.]')),
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Row(
        children: [
          Expanded(
            flex: 5,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${item.name.of(locale) ?? ''} (${InfoLabels.unit(item.unit, l10n)})',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                if (prev != null)
                  Text(
                    l10n.bazarEntryPrevious(
                      InfoLabels.priceRange(
                        prev.min,
                        prev.max,
                        item.unit,
                        l10n,
                        locale,
                      ),
                    ),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            flex: 3,
            child: TextField(
              controller: minController,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              inputFormatters: formatters,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: l10n.bazarEntryMin,
                isDense: true,
              ),
              onChanged: onMin,
            ),
          ),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            flex: 3,
            child: TextField(
              controller: maxController,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              inputFormatters: formatters,
              textInputAction: last
                  ? TextInputAction.done
                  : TextInputAction.next,
              decoration: InputDecoration(
                labelText: l10n.bazarEntryMax,
                isDense: true,
              ),
              onChanged: onMax,
            ),
          ),
        ],
      ),
    );
  }
}
