import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../data/seller_analytics_api.dart';

/// The smallest 1·2·5×10ⁿ at or above [max] — a round top for an axis.
double niceMax(num max) {
  if (max <= 0) return 1;
  final magnitude = math.pow(10, (math.log(max) / math.ln10).floor());
  for (final step in const [1, 2, 5, 10]) {
    if (step * magnitude >= max) return (step * magnitude).toDouble();
  }
  return (10 * magnitude).toDouble();
}

/// The seller dashboard (ADR 055/057): the Bengali summary line first, then
/// the period switcher, the numbers with their trends, views and contacts
/// day by day, how people got in touch, and the most viewed products.
class SellerDashboardScreen extends ConsumerStatefulWidget {
  const SellerDashboardScreen({
    required this.storeId,
    super.key,
    this.animate = true,
  });

  final String storeId;

  /// Off in golden tests (a chart mid-animation is a different picture).
  final bool animate;

  @override
  ConsumerState<SellerDashboardScreen> createState() =>
      _SellerDashboardScreenState();
}

class _SellerDashboardScreenState extends ConsumerState<SellerDashboardScreen> {
  int? _days;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final async = ref.watch(
      sellerAnalyticsProvider((storeId: widget.storeId, days: _days)),
    );
    return Scaffold(
      appBar: AppBar(title: Text(l10n.dashTitle)),
      body: switch (async) {
        AsyncData(:final value) => _Dashboard(
          data: value,
          animate: widget.animate,
          onPeriod: (days) => setState(() => _days = days),
        ),
        AsyncError() => ErrorState(
          title: l10n.dashLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(
            sellerAnalyticsProvider((storeId: widget.storeId, days: _days)),
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _Dashboard extends StatelessWidget {
  const _Dashboard({
    required this.data,
    required this.animate,
    required this.onPeriod,
  });

  final SellerAnalytics data;
  final bool animate;
  final ValueChanged<int> onPeriod;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    String n(num value) => localizeDigits(groupSouthAsian('$value'), locale);
    String trend(double? percent) {
      if (percent == null) return l10n.dashTrendNone;
      final whole = n(percent.round().abs());
      return percent >= 0 ? l10n.dashTrendUp(whole) : l10n.dashTrendDown(whole);
    }

    return ListView(
      key: const ValueKey('dashboard'),
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          locale == 'en' ? data.summaryEn : data.summaryBn,
          key: const ValueKey('dashboard-summary'),
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.xs,
          children: [
            for (final days in data.available)
              ChoiceChip(
                key: ValueKey('dashboard-period-$days'),
                label: Text(l10n.dashPeriodDays(n(days))),
                selected: days == data.days,
                onSelected: (_) => onPeriod(days),
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: AppSpacing.sm,
          crossAxisSpacing: AppSpacing.sm,
          childAspectRatio: 1.45,
          children: [
            _Tile(
              label: l10n.dashViews,
              value: n(data.views),
              note: trend(data.trendViews),
            ),
            _Tile(
              label: l10n.dashContacts,
              value: n(data.contacts.total),
              note: trend(data.trendContacts),
            ),
            _Tile(label: l10n.dashUniqueViewers, value: n(data.uniqueViewers)),
            _Tile(
              label: l10n.dashSaves,
              value: n(data.saves),
              note: trend(data.trendSaves),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.lg),
        Text(l10n.dashDaily, style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        Semantics(
          label: l10n.dashChartLabel(n(data.days)),
          child: SizedBox(
            height: 200,
            child: _DailyChart(data: data, animate: animate),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Row(
          children: [
            _Legend(
              color: theme.colorScheme.primary,
              label: l10n.dashDailyViews,
            ),
            const SizedBox(width: AppSpacing.md),
            _Legend(
              color: theme.colorScheme.tertiary,
              label: l10n.dashDailyContacts,
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.lg),
        Text(l10n.dashChannels, style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        SizedBox(
          height: 180,
          child: _ChannelChart(contacts: data.contacts, animate: animate),
        ),
        const SizedBox(height: AppSpacing.lg),
        Text(l10n.dashTopPosts, style: theme.textTheme.titleMedium),
        if (data.topPosts.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(l10n.dashEmpty),
          ),
        for (final (i, post) in data.topPosts.indexed)
          ListTile(
            key: ValueKey('dashboard-top-${post.postId}'),
            contentPadding: EdgeInsets.zero,
            leading: CircleAvatar(child: Text(n(i + 1))),
            title: Text(
              post.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              l10n.dashTopPostLine(n(post.views), n(post.contacts)),
            ),
            onTap: () => context.push(RoutePaths.postDetailFor(post.postId)),
          ),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.label, required this.value, this.note});

  final String label;
  final String value;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(label, style: theme.textTheme.bodySmall),
            Text(
              value,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            if (note != null)
              Text(
                note!,
                maxLines: 2,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(width: 14, height: 3, color: color),
      const SizedBox(width: AppSpacing.xs),
      Text(label, style: Theme.of(context).textTheme.bodySmall),
    ],
  );
}

/// Views and contacts per day: two lines on one axis.
class _DailyChart extends StatelessWidget {
  const _DailyChart({required this.data, required this.animate});

  final SellerAnalytics data;
  final bool animate;

  // How many day labels fit under the chart on a phone.
  static const _labels = 5;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final days = data.daily;
    final top = niceMax(
      days.fold<int>(0, (m, d) => math.max(m, math.max(d.views, d.contacts))),
    );
    final every = math.max(1, (days.length / _labels).ceil());
    LineChartBarData line(List<int> values, Color color, {bool fill = false}) =>
        LineChartBarData(
          spots: [
            for (final (i, v) in values.indexed)
              FlSpot(i.toDouble(), v.toDouble()),
          ],
          color: color,
          barWidth: 2.5,
          isCurved: false,
          dotData: const FlDotData(show: false),
          belowBarData: BarAreaData(
            show: fill,
            color: color.withValues(alpha: 0.12),
          ),
        );
    final small = theme.textTheme.labelSmall;
    return LineChart(
      duration: animate ? const Duration(milliseconds: 250) : Duration.zero,
      LineChartData(
        minY: 0,
        maxY: top,
        minX: 0,
        maxX: math.max(1, days.length - 1).toDouble(),
        lineTouchData: const LineTouchData(enabled: false),
        borderData: FlBorderData(show: false),
        gridData: FlGridData(
          drawVerticalLine: false,
          horizontalInterval: top / 2,
          getDrawingHorizontalLine: (_) => FlLine(
            color: theme.dividerColor,
            strokeWidth: 1,
            dashArray: [3, 3],
          ),
        ),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 36,
              interval: top / 2,
              getTitlesWidget: (value, meta) => SideTitleWidget(
                meta: meta,
                child: Text(
                  localizeDigits('${value.round()}', locale),
                  style: small,
                ),
              ),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 24,
              interval: 1,
              getTitlesWidget: (value, meta) {
                final i = value.round();
                final last = days.length - 1;
                if (i < 0 ||
                    i > last ||
                    (i != last && (last - i) % every != 0)) {
                  return const SizedBox.shrink();
                }
                final date = days[i].date;
                return SideTitleWidget(
                  meta: meta,
                  child: Text(
                    localizeDigits(
                      '${int.parse(date.substring(8))}/${int.parse(date.substring(5, 7))}',
                      locale,
                    ),
                    style: small,
                  ),
                );
              },
            ),
          ),
        ),
        lineBarsData: [
          line(
            [for (final d in days) d.views],
            theme.colorScheme.primary,
            fill: true,
          ),
          line([for (final d in days) d.contacts], theme.colorScheme.tertiary),
        ],
      ),
    );
  }
}

/// Contacts by channel as bars, each with its number above it.
class _ChannelChart extends StatelessWidget {
  const _ChannelChart({required this.contacts, required this.animate});

  final ContactCounts contacts;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final channels = [
      (l10n.dashChannelCall, contacts.call),
      (l10n.dashChannelWhatsapp, contacts.whatsapp),
      (l10n.dashChannelSms, contacts.sms),
      (l10n.dashChannelChat, contacts.chat),
    ];
    final top = niceMax(channels.fold<int>(0, (m, c) => math.max(m, c.$2)));
    return BarChart(
      duration: animate ? const Duration(milliseconds: 250) : Duration.zero,
      BarChartData(
        maxY: top,
        alignment: BarChartAlignment.spaceAround,
        borderData: FlBorderData(show: false),
        gridData: const FlGridData(show: false),
        barTouchData: BarTouchData(
          enabled: false,
          touchTooltipData: BarTouchTooltipData(
            getTooltipColor: (_) => Colors.transparent,
            tooltipPadding: EdgeInsets.zero,
            tooltipMargin: 2,
            getTooltipItem: (group, _, rod, _) => BarTooltipItem(
              localizeDigits('${rod.toY.round()}', locale),
              theme.textTheme.labelMedium!,
            ),
          ),
        ),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: const AxisTitles(),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 28,
              getTitlesWidget: (value, meta) => SideTitleWidget(
                meta: meta,
                child: Text(
                  channels[value.toInt()].$1,
                  style: theme.textTheme.labelMedium,
                ),
              ),
            ),
          ),
        ),
        barGroups: [
          for (final (i, (_, count)) in channels.indexed)
            BarChartGroupData(
              x: i,
              showingTooltipIndicators: const [0],
              barRods: [
                BarChartRodData(
                  toY: count.toDouble(),
                  width: 28,
                  color: theme.colorScheme.primary,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(4),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
