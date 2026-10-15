import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { appealQueueSchema } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationTabs } from '../moderation-tabs';
import { AppealsClient } from './appeals-client';

/** Appeals of this area's bans, before they escalate (appeal_escalation_days) — the area's admins (ADR 063). */
export default async function AppealsPage() {
  const viewer = await requireGrant({ module: 'appeals', action: 'read' });
  const [page, t] = await Promise.all([
    apiFetch({
      path: '/appeals/queue',
      schema: appealQueueSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('appeals'),
  ]);
  return (
    <>
      <ModerationTabs active="appeals" />
      <h1 className="mb-1 text-xl font-semibold">{t('pageTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>
      <AppealsClient items={page.items} scope="area" />
    </>
  );
}
