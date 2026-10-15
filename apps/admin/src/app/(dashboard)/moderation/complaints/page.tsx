import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { complaintAssigneesSchema, complaintQueueSchema } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { hasGrant } from '@/lib/auth/me';
import { ModerationTabs } from '../moderation-tabs';
import { ComplaintsClient } from './complaints-client';

/**
 * Complaints (ADR 063): what members filed about a person or a store of this
 * area, by due time (the SLA of its priority). Moderators and executives
 * assign, prioritise, work and resolve them — or open a ban from one.
 */
export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; mine?: string }>;
}) {
  const viewer = await requireGrant({ module: 'complaints', action: 'read' });
  const { status, mine } = await searchParams;
  const resolved = status === 'resolved';
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const [page, assignees, t] = await Promise.all([
    apiFetch({
      path: `/complaints/queue?${new URLSearchParams({
        ...(resolved ? { status: 'resolved' } : {}),
        ...(mine === 'true' ? { mine: 'true' } : {}),
      }).toString()}`,
      schema: complaintQueueSchema,
      ...auth,
    }),
    apiFetch({ path: '/complaints/assignees', schema: complaintAssigneesSchema, ...auth }),
    getTranslations('complaints'),
  ]);
  return (
    <>
      <ModerationTabs active="complaints" />
      <h1 className="mb-1 text-xl font-semibold">{t('pageTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>
      <ComplaintsClient
        items={page.items}
        assignees={assignees.items}
        filter={resolved ? 'resolved' : mine === 'true' ? 'mine' : 'open'}
        canWrite={hasGrant(viewer.permissions, { module: 'complaints', action: 'write' })}
        canBan={hasGrant(viewer.permissions, { module: 'bans', action: 'write' })}
      />
    </>
  );
}
