import type { Metadata } from 'next';
import type { Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CheckSquare, ExternalLink, MapPin } from 'lucide-react';
import { formatMoney, localizeDigits } from '@amar-elaka/dynamic-form';
import { areaTimeZone, InfoShell } from '@/components/info/info-page';
import { NoCoverage } from '@/components/no-coverage';
import { day } from '@/lib/info/engine-format';
import { govServiceDetail, govServiceVersion } from '@/lib/info/engine';
import { currentTenantConfig } from '@/lib/tenant';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$|^[0-9a-f-]{36}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tenant = await currentTenantConfig();
  const { slug } = await params;
  const service = tenant && SLUG.test(slug) ? await govServiceDetail(tenant, slug) : null;
  if (!service) return {};
  return {
    title: service.current.name.bn ?? service.current.name.en ?? undefined,
    description: service.current.summary ?? service.current.officeName,
    alternates: { canonical: `/info/gov/${service.slug}` },
  };
}

/**
 * One government service (ADR 065): the office on the map, hours, the
 * documents checklist, fees, steps and official links — versioned, with
 * "last verified on"; an older version is readable by its number.
 */
export default async function GovServicePage({ params, searchParams }: Props) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const [service, timeZone, t, query] = await Promise.all([
    govServiceDetail(tenant, slug),
    areaTimeZone(tenant),
    getTranslations('infoEngine'),
    searchParams,
  ]);
  if (!service) notFound();
  const wanted = Number(Array.isArray(query.v) ? query.v[0] : query.v);
  const old =
    Number.isInteger(wanted) && wanted > 0 && wanted !== service.current.versionNo
      ? await govServiceVersion(tenant, service.slug, wanted)
      : null;
  const v = old ?? service.current;
  const path = `/info/gov/${service.slug}`;
  return (
    <InfoShell
      title={v.name.bn ?? v.name.en ?? ''}
      path={path}
      trail={[{ name: t('hub.gov'), path: '/info/gov' }]}
    >
      {old ? (
        <p
          role="status"
          className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          {t('gov.viewingOld')} ·{' '}
          <Link href={path as Route} className="underline">
            {t('gov.current')}
          </Link>
        </p>
      ) : null}
      {v.summary ? <p className="mt-2 text-muted-foreground">{v.summary}</p> : null}
      <p className="mt-2 text-sm text-muted-foreground">
        {t('gov.verified', { date: day(service.lastVerifiedOn, timeZone) })}
      </p>
      {service.card.isStale && !old ? (
        <p
          role="status"
          className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          {t('stale')}
        </p>
      ) : null}

      <section className="mt-6 rounded-lg border border-border p-4">
        <h2 className="font-semibold">{t('gov.office')}</h2>
        <p>{v.officeName}</p>
        {v.address ? <p className="text-sm text-muted-foreground">{v.address}</p> : null}
        {v.hours ? (
          <p className="mt-1 text-sm">
            {t('gov.hours')}: {v.hours}
          </p>
        ) : null}
        {v.location ? (
          <Link
            href={
              `/map?lat=${v.location.lat.toFixed(5)}&lng=${v.location.lng.toFixed(5)}&z=17` as Route
            }
            className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline"
          >
            <MapPin className="size-4" aria-hidden />
            {t('openMap')}
          </Link>
        ) : null}
      </section>

      {v.documents.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-semibold">{t('gov.documents')}</h2>
          <ul className="mt-2 space-y-1">
            {v.documents.map((d) => (
              <li key={d} className="flex items-start gap-2">
                <CheckSquare className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                {d}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {v.fees.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-semibold">{t('gov.fees')}</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {v.fees.map((f) => (
              <li key={f.label} className="flex justify-between px-3 py-2">
                <span>{f.label}</span>
                <span className="font-semibold">৳ {formatMoney(f.amount, 'bn')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {v.steps.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-semibold">{t('gov.steps')}</h2>
          <ol className="mt-2 space-y-2">
            {v.steps.map((s, i) => (
              <li key={s} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm">
                  {localizeDigits(String(i + 1), 'bn')}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {v.links.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-semibold">{t('gov.links')}</h2>
          <ul className="mt-2 space-y-1">
            {v.links.map((l) => (
              <li key={l.url}>
                <a
                  href={l.url}
                  rel="noopener"
                  target="_blank"
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                >
                  {l.label}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {service.versions.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('gov.versions')}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {service.versions.map((ver) => (
              <li key={ver.versionNo}>
                <Link href={`${path}?v=${ver.versionNo}` as Route} className="hover:underline">
                  {t('gov.version', {
                    no: localizeDigits(String(ver.versionNo), 'bn'),
                    date: day(ver.createdAt, timeZone),
                  })}
                </Link>
                {ver.changeNote ? (
                  <span className="text-muted-foreground"> — {ver.changeNote}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </InfoShell>
  );
}
