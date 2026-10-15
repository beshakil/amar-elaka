import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { appealQueueSchema } from '@/lib/api/schemas';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { AppealsClient } from '../../moderation/appeals/appeals-client';

/** The platform's appeals (ADR 063): escalated area appeals and every global one — the final word. */
export default async function PlatformAppealsPage() {
  const viewer = await requirePlatformAdmin();
  const [page, t] = await Promise.all([
    apiFetch({
      path: '/platform/appeals',
      schema: appealQueueSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('appeals'),
  ]);
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t('platformTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('platformDescription')}</p>
      <AppealsClient items={page.items} scope="platform" />
    </>
  );
}
