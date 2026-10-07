import { apiFetch } from '@/lib/api/fetch';
import { moderationQueuePageSchema } from '@/lib/api/schemas';
import { redirect } from 'next/navigation';
import { currentViewer, hasGrant } from '@/lib/auth/me';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationClient } from './moderation-client';
import { ModerationTabs } from './moderation-tabs';
import { isQueueReason } from './reasons';

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // ./layout.tsx lets place moderators in too: this page is posts:approve only,
  // so someone who moderates places alone lands on their tab.
  const current = await currentViewer();
  if (
    !hasGrant(current.permissions, { module: 'posts', action: 'approve' }) &&
    hasGrant(current.permissions, { module: 'places', action: 'approve' })
  ) {
    redirect('/moderation/places');
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
