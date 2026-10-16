import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { emergencyAdminListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { EmergencyClient } from './emergency-client';
import { LocalInfoTabs } from './local-info-tabs';

/**
 * The area's emergency contacts (ADR 064): thana, fire station, hospitals,
 * ambulances… Field agents add and re-verify them; the apps keep a copy
 * that works with no network.
 */
export default async function EmergencyContactsPage() {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const [list, t] = await Promise.all([
    apiFetch({
      path: '/info/emergency/contacts',
      schema: emergencyAdminListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="emergency" />
      <h1 className="mb-1 text-xl font-semibold">{t('emergency.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('emergency.description')}</p>
      <EmergencyClient items={list.items} />
    </>
  );
}
