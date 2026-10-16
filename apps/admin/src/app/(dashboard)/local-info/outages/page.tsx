import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { outageAdminListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { LocalInfoTabs } from '../local-info-tabs';
import { OutagesClient } from './outages-client';

/**
 * Scheduled load-shedding and outages (ADR 065): the area team posts the
 * window, utility and locality from a phone; each ends by itself.
 * Neighbours' reports are aggregated by the API, not edited here.
 */
export default async function OutagesAdminPage() {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const [list, t] = await Promise.all([
    apiFetch({
      path: '/info/outages/manage',
      schema: outageAdminListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="outages" />
      <h1 className="mb-1 text-xl font-semibold">{t('outages.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('outages.description')}</p>
      <OutagesClient list={list} />
    </>
  );
}
