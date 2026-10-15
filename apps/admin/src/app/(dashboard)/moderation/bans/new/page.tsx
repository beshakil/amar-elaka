import { getTranslations } from 'next-intl/server';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationTabs } from '../../moderation-tabs';
import { BanForm } from './ban-form';

/**
 * Issue a ban (ADR 063): find the member by phone, or come from a complaint
 * (it is resolved with the ban). The ladder (ban_ladder_days) decides the
 * length unless a reason to depart from it is given; permanent is the
 * area admin's, with evidence.
 */
export default async function NewBanPage({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string; complaintId?: string; name?: string }>;
}) {
  const viewer = await requireGrant({ module: 'bans', action: 'write' });
  const { userId, complaintId, name } = await searchParams;
  const t = await getTranslations('bans');
  const role = viewer.permissions.role ?? '';
  return (
    <>
      <ModerationTabs active="bans" />
      <h1 className="mb-1 text-xl font-semibold">{t('issueTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('issueDescription')}</p>
      <BanForm
        initial={userId ? { userId, name: name ?? null } : null}
        complaintId={complaintId ?? null}
        canPermanent={role === 'tenant_admin' || role === 'partner_owner'}
      />
    </>
  );
}
