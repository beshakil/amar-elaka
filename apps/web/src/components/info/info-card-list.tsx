import Link from 'next/link';
import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Building2,
  Bus,
  History,
  Info,
  Landmark,
  Megaphone,
  PowerOff,
  SearchCheck,
  type LucideIcon,
} from 'lucide-react';
import type { InfoCard } from '@/lib/api/schemas';
import { distanceText, infoHref, infoWhen } from '@/lib/info/engine-format';

const ICONS: Record<string, LucideIcon> = {
  outage: PowerOff,
  outage_report: PowerOff,
  notice: Megaphone,
  lost_found: SearchCheck,
  transport: Bus,
  gov_service: Landmark,
  directory: Building2,
};

/**
 * THE card of every info list and of the home page (ADR 065): type icon,
 * title, summary, badges in words, the time line, the distance and — past
 * the type's window — "may be out of date". Plain links (crawlable).
 */
export async function InfoCardList({
  cards,
  timeZone,
  showType = false,
}: {
  cards: InfoCard[];
  timeZone: string;
  showType?: boolean;
}) {
  const t = await getTranslations('infoEngine');
  if (cards.length === 0) return <p className="mt-4 text-muted-foreground">{t('empty')}</p>;
  const badge = (code: string) => (t.has(`badges.${code}`) ? t(`badges.${code}`) : null);
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="info-cards">
      {cards.map((card) => {
        const Icon = ICONS[card.type] ?? Info;
        const urgent = card.badges.includes('ongoing') || card.badges.includes('janaza');
        const when = infoWhen(card, timeZone, {
          window: (from, to) => t('window', { from, to }),
          lastSeen: (w) => t('lastSeen', { when: w }),
          updated: (date) => t('updated', { date }),
        });
        const distance = distanceText(card.distanceMeters, {
          m: (d) => t('distanceM', { distance: d }),
          km: (d) => t('distanceKm', { distance: d }),
        });
        const summary =
          card.type === 'outage_report'
            ? t('reportedBy', { count: card.summary ?? '' })
            : card.summary;
        const href = infoHref(card);
        const body = (
          <div className="flex gap-3 p-3">
            {card.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- a public media variant, sized here
              <img
                src={card.image.url}
                alt=""
                width={64}
                height={64}
                loading="lazy"
                className="size-16 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                  urgent
                    ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200'
                    : 'bg-muted text-brand'
                }`}
              >
                <Icon className="size-5" aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              {showType && t.has(`types.${card.type}`) ? (
                <span className="block text-xs text-brand">{t(`types.${card.type}`)}</span>
              ) : null}
              <span className="block font-medium">{card.title.bn ?? card.title.en}</span>
              {summary ? (
                <span className="line-clamp-2 block text-sm text-muted-foreground">{summary}</span>
              ) : null}
              {when || distance ? (
                <span className="block text-xs text-muted-foreground">
                  {[when, distance].filter(Boolean).join(' · ')}
                </span>
              ) : null}
              <span className="mt-1 flex flex-wrap gap-1">
                {card.badges.map((code) => {
                  const label = badge(code);
                  return label ? (
                    <span key={code} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {label}
                    </span>
                  ) : null;
                })}
                {card.isStale ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    <History className="size-3" aria-hidden />
                    {t('stale')}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        );
        return (
          <li key={`${card.type}-${card.id}`} className="rounded-lg border border-border bg-card">
            {href ? (
              <Link href={href as Route} className="block rounded-lg hover:bg-muted">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Filter chips as links (the URL holds the filter; no client JS). */
export function InfoFilters({
  label,
  base,
  filters,
  active,
}: {
  /** The chips' accessible name. */
  label: string;
  base: string;
  filters: { label: string; value: string | null; param: string }[];
  active: string | null;
}) {
  return (
    <nav className="mt-4 flex flex-wrap gap-2" aria-label={label}>
      {filters.map((f) => {
        const selected = f.value === active;
        const href = f.value === null ? base : `${base}?${f.param}=${encodeURIComponent(f.value)}`;
        return (
          <Link
            key={f.value ?? 'all'}
            href={href as Route}
            aria-current={selected ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${
              selected
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-border hover:bg-muted'
            }`}
          >
            {f.label}
          </Link>
        );
      })}
    </nav>
  );
}
