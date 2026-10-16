import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ArrowDown, ArrowUp, History, Minus } from 'lucide-react';
import { formatMoney } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import type { BazarBoard } from '@/lib/api/schemas';
import { groupBy, sparklineSegments } from '@/lib/info/bazar';
import { bazarBoard } from '@/lib/info/load';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

// The sparkline's drawing box (CSS pixels): layout, not a business rule.
const SPARK_WIDTH = 72;
const SPARK_HEIGHT = 24;

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('bazar')]);
  return {
    title: t('title'),
    description: tenant ? t('description', { tenant: tenant.nameBn }) : undefined,
    alternates: { canonical: '/info/bazar' },
  };
}

/**
 * The area's daily bazar prices (ADR 064): today vs yesterday with an arrow,
 * the trend, Bengali numerals, the sponsor, and a banner when today's
 * prices aren't in yet.
 */
export default async function BazarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  // The farm-input board (ADR 065) is the same page.
  const agri = (await searchParams).board === 'agri';
  const [t, tNav, tHome, tInfo, board] = await Promise.all([
    getTranslations('bazar'),
    getTranslations('nav'),
    getTranslations('home'),
    getTranslations('infoEngine'),
    // Farming off in this area: the API refuses the agri board.
    bazarBoard(tenant, agri ? 'agri' : 'bazar').catch((error: unknown) => {
      if (agri) return null;
      throw error;
    }),
  ]);
  if (!board) return <p className="text-muted-foreground">{tInfo('agri.disabled')}</p>;
  const title = agri ? t('agriTitle') : t('title');
  const breadcrumbs = [
    { name: tNav('home'), path: '/' },
    { name: tNav('info'), path: '/info' },
    { name: title, path: agri ? '/info/bazar?board=agri' : '/info/bazar' },
  ];
  const unit = (code: string) => (tHome.has(`units.${code}`) ? tHome(`units.${code}`) : code);
  const range = (p: { min: string; max: string }, unitCode: string) =>
    p.min === p.max
      ? t('single', { price: formatMoney(p.min, 'bn'), unit: unit(unitCode) })
      : tHome('bazarRange', {
          min: formatMoney(p.min, 'bn'),
          max: formatMoney(p.max, 'bn'),
          unit: unit(unitCode),
        });
  const groups = groupBy(board.items, (item) => item.group);
  const day = (iso: string) =>
    new Intl.DateTimeFormat('bn-BD', { day: 'numeric', month: 'long' }).format(
      new Date(`${iso}T00:00:00`),
    );

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(breadcrumbJsonLd(breadcrumbs, await currentOrigin())),
        }}
      />
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{day(board.date)}</p>
      {board.sponsor ? (
        <p className="mt-2 text-sm text-brand">
          {board.sponsor.linkUrl ? (
            <a href={board.sponsor.linkUrl} rel="sponsored noopener" className="hover:underline">
              {t('sponsoredBy', { name: board.sponsor.name.bn ?? board.sponsor.name.en ?? '' })}
            </a>
          ) : (
            t('sponsoredBy', { name: board.sponsor.name.bn ?? board.sponsor.name.en ?? '' })
          )}
          {board.sponsor.tagline ? ` — ${board.sponsor.tagline}` : null}
        </p>
      ) : null}
      {board.isStale ? (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 rounded-lg bg-amber-100 px-4 py-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <History className="size-5" aria-hidden />
          {board.lastUpdated ? t('stale', { date: day(board.lastUpdated) }) : t('never')}
        </p>
      ) : null}

      {groups.map(([group, items]) => (
        <section key={group} className="mt-6">
          <h2 className="font-semibold">
            {t.has(`groups.${group}`) ? t(`groups.${group}`) : group}
          </h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('item')}</th>
                  <th className="px-3 py-2 font-medium">{t('today')}</th>
                  <th className="px-3 py-2 font-medium">{t('yesterday')}</th>
                  <th className="px-3 py-2 font-medium">
                    {t('trend', { days: board.trendDays.toLocaleString('bn-BD') })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item) => (
                  <tr key={`${item.commodityId}-${item.unit}`}>
                    <td className="px-3 py-2">{item.name.bn ?? item.name.en ?? item.code}</td>
                    <td className="px-3 py-2 font-semibold">
                      <span className="inline-flex items-center gap-1">
                        {item.today ? range(item.today, item.unit) : '—'}
                        <DirectionIcon
                          direction={item.direction}
                          labels={{ up: t('up'), down: t('down'), same: t('same') }}
                        />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {item.yesterday ? range(item.yesterday, item.unit) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Sparkline trend={item.trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function DirectionIcon({
  direction,
  labels,
}: {
  direction: BazarBoard['items'][number]['direction'];
  labels: Record<'up' | 'down' | 'same', string>;
}) {
  if (direction === 'up') {
    return <ArrowUp className="size-4 text-red-600" aria-label={labels.up} />;
  }
  if (direction === 'down') {
    return <ArrowDown className="size-4 text-green-700" aria-label={labels.down} />;
  }
  if (direction === 'same') {
    return <Minus className="size-4 text-muted-foreground" aria-label={labels.same} />;
  }
  return null;
}

function Sparkline({ trend }: { trend: BazarBoard['items'][number]['trend'] }) {
  const segments = sparklineSegments(trend, SPARK_WIDTH, SPARK_HEIGHT);
  if (segments.length === 0) return null;
  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      aria-hidden
      className="overflow-visible text-brand"
    >
      {segments.map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
