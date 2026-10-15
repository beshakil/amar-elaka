import { getTranslations } from 'next-intl/server';
import type { BanNotice } from '@/lib/api/schemas';

/** A restricted seller still uses the panel; this says so and links to why (ADR 063). */
export async function BanBanner({ bans }: { bans: BanNotice[] }) {
  if (bans.length === 0) return null;
  const t = await getTranslations('account');
  return (
    <p
      role="status"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      data-testid="ban-banner"
    >
      {t('banner')}{' '}
      <a href="/account/bans" className="font-medium underline">
        {t('bannerLink')}
      </a>
    </p>
  );
}
