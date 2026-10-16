import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { routeAdminListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { LocalInfoTabs } from '../local-info-tabs';
import { TransportClient } from './transport-client';

/**
 * Transport (ADR 065): the area team keeps each route — mode, operator,
 * stops, departure times, fares — and marks it checked ("last verified").
 */
export default async function TransportAdminPage() {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const [list, t] = await Promise.all([
    apiFetch({
      path: '/info/transport/manage',
      schema: routeAdminListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="transport" />
      <h1 className="mb-1 text-xl font-semibold">{t('transport.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('transport.description')}</p>
      <TransportClient routes={list.items} />
    </>
  );
}
