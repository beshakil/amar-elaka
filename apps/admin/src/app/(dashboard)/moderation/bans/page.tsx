import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { banListSchema } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { hasGrant } from '@/lib/auth/me';
import { ModerationTabs } from '../moderation-tabs';
import { BansClient } from './bans-client';

/**
 * This area's bans (ADR 063): who, why (the internal text is for staff), how
 * long, the ladder step, an open appeal. Moderators issue; only the area's
 * admins lift.
 */
export default async function BansPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const viewer = await requireGrant({ module: 'bans', action: 'read' });
  const { all } = await searchParams;
  const [page, t] = await Promise.all([
    apiFetch({
      path: `/bans${all === 'true' ? '?active=false' : ''}`,
      schema: banListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('bans'),
  ]);
  const role = viewer.permissions.role ?? '';
  return (
    <>
      <ModerationTabs active="bans" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Link
          href={all === 'true' ? '/moderation/bans' : '/moderation/bans?all=true'}
          className="text-sm underline"
        >
          {all === 'true' ? t('showActive') : t('showAll')}
        </Link>
        {hasGrant(viewer.permissions, { module: 'bans', action: 'write' }) && (
          <Link
            href={'/moderation/bans/new'}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            data-testid="ban-new"
          >
            {t('issue')}
          </Link>
        )}
      </div>
      <BansClient
        items={page.items}
        canLift={role === 'tenant_admin' || role === 'partner_owner'}
      />
    </>
  );
}
