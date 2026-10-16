import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { bloodRequestListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_STAFF_ROLES } from '@/lib/nav/nav';
import { LocalInfoTabs } from '../local-info-tabs';
import { BloodRequestsClient } from './blood-client';

/**
 * The area's urgent blood requests (ADR 064), newest first. A fake request
 * is a known scam: a moderator takes it down with a reason, which writes the
 * moderation action in the same transaction.
 */
export default async function BloodRequestsPage() {
  const viewer = await requireRoles(LOCAL_INFO_STAFF_ROLES);
  const [list, t] = await Promise.all([
    apiFetch({
      path: '/blood/requests/area',
      schema: bloodRequestListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="blood" />
      <h1 className="mb-1 text-xl font-semibold">{t('blood.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('blood.description')}</p>
      <BloodRequestsClient items={list.items} />
    </>
  );
}
