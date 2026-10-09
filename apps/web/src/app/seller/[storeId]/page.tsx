import type { Route } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { BarList } from '@/components/seller/bar-list';
import { DailyChart } from '@/components/seller/daily-chart';
import { requireViewer } from '@/lib/auth/viewer';
import { listingPath } from '@/lib/seo/slug';
import { trendPercent } from '@/lib/seller/charts';
import { storeAnalytics } from '@/lib/seller/load';
import { cn } from '@/lib/utils';

/** The store's dashboard (ADR 055/057): the Bengali summary line first, then the numbers behind it. */
export default async function SellerDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const [{ storeId }, query, viewer] = await Promise.all([params, searchParams, requireViewer()]);
  const asked = Number(query.period);
  const data = await storeAnalytics(
    viewer,
    storeId,
    Number.isInteger(asked) && asked > 0 ? asked : null,
  );
  const [t, format] = await Promise.all([getTranslations('seller.dashboard'), getFormatter()]);
  const n = (value: number) => localizeDigits(format.number(value), 'bn');
  const day = (iso: string) =>
    localizeDigits(format.dateTime(new Date(iso), { day: 'numeric', month: 'short' }), 'bn');
  const trendLine = (trend: number | null) => {
    const percent = trendPercent(trend);
    if (percent === null) return t('trendNone');
    const value = localizeDigits(String(Math.abs(percent)), 'bn');
    return percent >= 0 ? t('trendUp', { percent: value }) : t('trendDown', { percent: value });
  };
  const tiles: { label: string; value: number; trend?: number | null }[] = [
    { label: t('views'), value: data.totals.views, trend: data.trend.views },
    { label: t('contacts'), value: data.totals.contacts.total, trend: data.trend.contacts },
    { label: t('uniqueViewers'), value: data.totals.uniqueViewers },
    { label: t('saves'), value: data.totals.saves, trend: data.trend.saves },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-lg font-medium" data-testid="summary">
          {data.summary.bn}
        </p>
        <nav aria-label={t('period')} className="flex gap-1">
          {data.period.available.map((days) => (
            <Link
              key={days}
              href={`/seller/${storeId}?period=${days}` as Route}
              aria-current={days === data.period.days ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                days === data.period.days
                  ? 'border-brand bg-brand text-brand-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {t('days', { days: localizeDigits(String(days), 'bn') })}
            </Link>
          ))}
        </nav>
      </div>

      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.label} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">{tile.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{n(tile.value)}</p>
            {tile.trend !== undefined && (
              <p className="mt-1 text-xs text-muted-foreground">{trendLine(tile.trend)}</p>
            )}
          </li>
        ))}
      </ul>

      <section aria-labelledby="daily" className="rounded-lg border p-4">
        <h2 id="daily" className="mb-3 font-semibold">
          {t('dailyTitle')}
        </h2>
        <DailyChart
          days={data.daily}
          label={t('chartLabel', { days: localizeDigits(String(data.period.days), 'bn') })}
          legend={{ views: t('dailyViews'), contacts: t('dailyContacts') }}
          formatDay={day}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="channels" className="rounded-lg border p-4">
          <h2 id="channels" className="mb-3 font-semibold">
            {t('channelsTitle')}
          </h2>
          <BarList
            items={(['call', 'whatsapp', 'sms', 'chat'] as const).map((channel) => ({
              label: t(`channels.${channel}`),
              value: data.totals.contacts[channel],
            }))}
          />
        </section>

        <section aria-labelledby="top" className="rounded-lg border p-4">
          <h2 id="top" className="mb-3 font-semibold">
            {t('topPosts')}
          </h2>
          {data.topPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {data.topPosts.map((post) => (
                <li key={post.postId} className="flex justify-between gap-3">
                  <Link
                    href={listingPath(post.postId, post.title) as Route}
                    className="truncate hover:underline"
                  >
                    {post.title}
                  </Link>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {n(post.metrics.views)} · {n(post.metrics.contacts.total)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {data.topQueries.length > 0 && (
        <section aria-labelledby="queries" className="rounded-lg border p-4">
          <h2 id="queries" className="mb-3 font-semibold">
            {t('topQueries')}
          </h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {data.topQueries.map((q) => (
              <li key={q.query} className="rounded-full bg-muted px-3 py-1">
                “{q.query}” · {t('searchers', { count: n(q.searchers) })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
