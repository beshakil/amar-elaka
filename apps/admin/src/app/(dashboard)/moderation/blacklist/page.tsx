import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { blacklistPageSchema } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { hasGrant } from '@/lib/auth/me';
import { BlacklistClient } from '../../platform/blacklist/blacklist-client';
import { ModerationTabs } from '../moderation-tabs';
import { RecommendForm } from './recommend-form';

/**
 * The global blacklist, from an area (ADR 063): its admins may only
 * recommend someone; the platform decides. Their recommendations and how
 * they ended are listed here.
 */
export default async function BlacklistPage() {
  const viewer = await requireGrant({ module: 'blacklist', action: 'read' });
  const [page, t] = await Promise.all([
    apiFetch({
      path: '/blacklist/recommendations',
      schema: blacklistPageSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('blacklist'),
  ]);
  return (
    <>
      <ModerationTabs active="blacklist" />
      <h1 className="mb-1 text-xl font-semibold">{t('pageTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>
      {hasGrant(viewer.permissions, { module: 'blacklist', action: 'write' }) && <RecommendForm />}
      <h2 className="mb-2 mt-6 font-medium">{t('ours')}</h2>
      <BlacklistClient items={page.items} mode="area" />
    </>
  );
}
