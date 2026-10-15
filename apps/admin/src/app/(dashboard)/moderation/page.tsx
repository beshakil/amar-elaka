import type { Route } from 'next';
import { apiFetch } from '@/lib/api/fetch';
import { moderationQueuePageSchema } from '@/lib/api/schemas';
import { redirect } from 'next/navigation';
import { currentViewer, hasGrant } from '@/lib/auth/me';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationClient } from './moderation-client';
import { MODERATION_TABS, ModerationTabs } from './moderation-tabs';
import { isQueueReason } from './reasons';

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // ./layout.tsx lets every moderation grant in: someone who can't moderate
  // posts lands on the first tab they can work.
  const current = await currentViewer();
  if (!hasGrant(current.permissions, { module: 'posts', action: 'approve' })) {
    const first = MODERATION_TABS.find((tab) => hasGrant(current.permissions, tab.grant));
    if (first) redirect(first.href as Route);
  }
  const viewer = await requireGrant({ module: 'posts', action: 'approve' });
  const { reason } = await searchParams;
  const filter = isQueueReason(reason) ? reason : undefined;

  const page = await apiFetch({
    path: `/moderation/queue${filter ? `?reason=${filter}` : ''}`,
    schema: moderationQueuePageSchema,
    tenantId: viewer.session.tenantId,
    accessToken: viewer.session.accessToken,
  });

  return (
    <>
      <ModerationTabs active="posts" />
      <ModerationClient
        items={page.items}
        reason={filter ?? null}
        // Irreversible scrub: tenant admins only (posts:delete), same as the API.
        canHardRemove={hasGrant(viewer.permissions, { module: 'posts', action: 'delete' })}
      />
    </>
  );
}
