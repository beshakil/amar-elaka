import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { blacklistPageSchema } from '@/lib/api/schemas';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { cn } from '@/lib/utils';
import { BlacklistClient } from './blacklist-client';

const STATUSES = ['recommended', 'active', 'rejected', 'revoked'] as const;

/** The global blacklist (ADR 063): recommendations from the areas to approve or reject, active entries to revoke. */
export default async function PlatformBlacklistPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const viewer = await requirePlatformAdmin();
  const { status } = await searchParams;
  const current = STATUSES.find((s) => s === status) ?? 'recommended';
  const [page, t] = await Promise.all([
    apiFetch({
      path: `/platform/blacklist?status=${current}`,
      schema: blacklistPageSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('blacklist'),
  ]);
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t('platformTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('platformDescription')}</p>
      <nav className="mb-4 flex gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/platform/blacklist?status=${s}` as Route}
            aria-current={s === current ? 'page' : undefined}
            className={cn(
              'rounded-md border px-3 py-1',
              s === current ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {t(`status.${s}`)}
          </Link>
        ))}
      </nav>
      <BlacklistClient items={page.items} mode="platform" />
    </>
  );
}
