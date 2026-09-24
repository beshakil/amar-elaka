import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { tenantSummarySchema } from '@/lib/api/schemas';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { TenantsClient } from './tenants-client';

/** Platform scope only; also enforced by ./layout.tsx, which makes a denial a real 404. */
export default async function TenantsPage() {
  const viewer = await requirePlatformAdmin();

  const tenants = await apiFetch({
    path: '/tenants',
    schema: z.array(tenantSummarySchema),
    tenantId: viewer.session.tenantId,
    accessToken: viewer.session.accessToken,
  });

  return <TenantsClient tenants={tenants} />;
}
