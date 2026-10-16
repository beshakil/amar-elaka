import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import type { TenantConfig } from '@/lib/api/schemas';
import { infoList, prayerSettings } from '@/lib/info/engine';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';
import { InfoCardList, InfoFilters } from './info-card-list';

/** The area's timezone (the API's, never assumed). */
export async function areaTimeZone(tenant: TenantConfig): Promise<string> {
  return (await prayerSettings(tenant)).timezone;
}

/** Title + breadcrumbs (Home › Info › …) + JSON-LD, around a page's body. */
export async function InfoShell({
  title,
  path,
  trail = [],
  children,
}: {
  title: string;
  path: string;
  /** Crumbs between Info and this page. */
  trail?: { name: string; path: string }[];
  children: ReactNode;
}) {
  const tNav = await getTranslations('nav');
  const crumbs = [
    { name: tNav('home'), path: '/' },
    { name: tNav('info'), path: '/info' },
    ...trail,
    { name: title, path },
  ];
  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(breadcrumbJsonLd(crumbs, await currentOrigin())),
        }}
      />
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </>
  );
}

/**
 * Every info type's list page (ADR 065): the cards near the area's centre,
 * filter chips held in the URL, a note when the list is radius-bound.
 */
export async function InfoListPage({
  title,
  path,
  api,
  filter,
  intro,
}: {
  title: string;
  path: string;
  /** The API list path. */
  api: string;
  filter?: {
    param: string;
    options: { label: string; value: string | null }[];
    active: string | null;
  };
  intro?: ReactNode;
}) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const t = await getTranslations('infoEngine');
  const query: Record<string, string> = filter?.active ? { [filter.param]: filter.active } : {};
  const [list, timeZone] = await Promise.all([infoList(tenant, api, query), areaTimeZone(tenant)]);
  return (
    <InfoShell title={title} path={path}>
      {intro}
      {filter ? (
        <InfoFilters
          label={t('filters')}
          base={path}
          active={filter.active}
          filters={filter.options.map((o) => ({ ...o, param: filter.param }))}
        />
      ) : null}
      {list.radiusKm !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('aroundArea', { km: list.radiusKm.toLocaleString('bn-BD') })}
        </p>
      ) : null}
      <InfoCardList cards={list.items} timeZone={timeZone} />
    </InfoShell>
  );
}

/** One query parameter, if it is one of the allowed values. */
export function pick<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
