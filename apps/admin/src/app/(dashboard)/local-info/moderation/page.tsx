import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { infoModerationQueueSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_STAFF_ROLES } from '@/lib/nav/nav';
import { LocalInfoTabs } from '../local-info-tabs';
import { ModerationClient } from './moderation-client';

/**
 * The info engine's one moderation queue (ADR 065): members' community
 * notices (janaza and condolence included) and lost & found reports
 * waiting, or reported. Each decision writes moderation_actions with its
 * reason in the same transaction, and the author is told.
 */
export default async function InfoModerationPage() {
  const viewer = await requireRoles(LOCAL_INFO_STAFF_ROLES);
  const [queue, t] = await Promise.all([
    apiFetch({
      path: '/info/moderation/queue',
      schema: infoModerationQueueSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="moderation" />
      <h1 className="mb-1 text-xl font-semibold">{t('moderation.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('moderation.description')}</p>
      <ModerationClient items={queue.items} />
    </>
  );
}
