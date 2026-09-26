import { apiFetch } from '@/lib/api/fetch';
import { moderationQueuePageSchema } from '@/lib/api/schemas';
import { hasGrant } from '@/lib/auth/me';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationClient } from './moderation-client';
import { isQueueReason } from './reasons';

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Also enforced by ./layout.tsx, which is what makes a denial a real 404.
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
    <ModerationClient
      items={page.items}
      reason={filter ?? null}
      // Irreversible scrub: tenant admins only (posts:delete), same as the API.
      canHardRemove={hasGrant(viewer.permissions, { module: 'posts', action: 'delete' })}
    />
  );
}
