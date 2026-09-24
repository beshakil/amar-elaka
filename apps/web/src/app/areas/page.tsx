import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { currentTenantId, listTenants } from '@/lib/tenant';
import type { TenantSummary } from '@/lib/api/schemas';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('areaSwitcher');
  return { title: t('title'), description: t('description'), alternates: { canonical: '/areas' } };
}

/** Each tenant lives on its own subdomain, so switching area is a cross-origin link. */
function tenantOrigin(slug: string): string {
  const origin = new URL(env().SITE_ORIGIN);
  return `${origin.protocol}//${slug}.${env().APP_ROOT_DOMAIN}${origin.port ? `:${origin.port}` : ''}`;
}

function groupByDistrict(tenants: TenantSummary[]): [string, TenantSummary[]][] {
  const groups = new Map<string, TenantSummary[]>();
  for (const tenant of tenants) {
    const district = tenant.districtNameBn ?? tenant.nameBn;
    groups.set(district, [...(groups.get(district) ?? []), tenant]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'bn'));
}

export default async function AreasPage() {
  const t = await getTranslations('areaSwitcher');
  const [tenants, activeTenantId] = await Promise.all([listTenants(), currentTenantId()]);
  const groups = groupByDistrict(tenants);

  return (
    <section>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('description')}</p>

      {groups.length === 0 ? (
        <p className="mt-8 text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="mt-8 space-y-8">
          {groups.map(([district, areas]) => (
            <div key={district}>
              <h2 className="text-sm font-semibold text-muted-foreground">{district}</h2>
              <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {areas.map((tenant) => (
                  <li key={tenant.id}>
                    <a
                      href={tenantOrigin(tenant.slug)}
                      aria-current={tenant.id === activeTenantId ? 'true' : undefined}
                      className={
                        tenant.id === activeTenantId
                          ? 'block rounded-lg border border-brand bg-card px-4 py-3'
                          : 'block rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted'
                      }
                    >
                      {tenant.nameBn}
                      {tenant.id === activeTenantId ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t('current')}
                        </span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
