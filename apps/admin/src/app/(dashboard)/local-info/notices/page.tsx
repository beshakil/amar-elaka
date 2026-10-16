import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { infoListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { isLocalInfoStaff, LocalInfoTabs } from '../local-info-tabs';
import { NoticesClient } from './notices-client';

/**
 * Notices (ADR 065): the area team publishes union/pourashava, school,
 * mosque committee and weather/farming advisories — with a validity window
 * and an optional PDF or photo — straight from a phone. Members' community
 * notices go through the moderation tab.
 */
export default async function NoticesAdminPage() {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const [local, advisory, staff, t] = await Promise.all([
    apiFetch({
      path: '/info/notices',
      query: { category: 'local' },
      schema: infoListSchema,
      ...auth,
    }),
    apiFetch({
      path: '/info/notices',
      query: { category: 'advisory' },
      schema: infoListSchema,
      ...auth,
    }),
    isLocalInfoStaff(),
    getTranslations('localInfo'),
  ]);
  // Only this area's own notices are the team's to manage (the lists are radius-based).
  const own = [...local.items, ...advisory.items].filter(
    (c) => c.tenantId === viewer.session.tenantId,
  );
  return (
    <>
      <LocalInfoTabs active="notices" />
      <h1 className="mb-1 text-xl font-semibold">{t('notices.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('notices.description')}</p>
      <NoticesClient notices={own} staff={staff} />
    </>
  );
}
