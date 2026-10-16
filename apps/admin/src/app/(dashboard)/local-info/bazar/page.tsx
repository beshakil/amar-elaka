import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import {
  bazarCatalogueSchema,
  bazarEntrySheetSchema,
  bazarSponsorAdminSchema,
  infoServicesSchema,
} from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { cn } from '@/lib/utils';
import { isLocalInfoStaff, LocalInfoTabs } from '../local-info-tabs';
import { BazarCatalogueForm, BazarEntryForm, BazarSponsorForm } from './bazar-client';

/**
 * The bazar board (ADR 064): today's prices in one save (field agents and
 * staff, yesterday prefilled), and — staff only — which items the area's
 * board shows and its sponsor (display only; selling it is week 16).
 */
export default async function BazarAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; board?: string }>;
}) {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const { date, board: boardParam } = await searchParams;
  // The farm-input board (ADR 065): same sheet, its own items.
  const board = boardParam === 'agri' ? 'agri' : 'bazar';
  const staff = await isLocalInfoStaff();
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const [sheet, catalogue, sponsor, t, services] = await Promise.all([
    apiFetch({
      path: '/bazar/entry',
      query: { board, ...(day ? { date: day } : {}) },
      schema: bazarEntrySheetSchema,
      ...auth,
    }),
    staff ? apiFetch({ path: '/bazar/catalogue', schema: bazarCatalogueSchema, ...auth }) : null,
    staff ? apiFetch({ path: '/bazar/sponsor', schema: bazarSponsorAdminSchema, ...auth }) : null,
    getTranslations('localInfo'),
    apiFetch({ path: '/info/services', schema: infoServicesSchema, ...auth }).catch(() => ({
      agri: false,
    })),
  ]);
  return (
    <>
      <LocalInfoTabs active="bazar" />
      <h1 className="mb-1 text-xl font-semibold">{t('bazar.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('bazar.description')}</p>
      {services.agri ? (
        <nav aria-label={t('bazar.boards')} className="mb-4 flex gap-2">
          {(['bazar', 'agri'] as const).map((b) => (
            <Link
              key={b}
              href={(b === 'agri' ? '/local-info/bazar?board=agri' : '/local-info/bazar') as Route}
              aria-current={b === board ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                b === board
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {t(`bazar.board.${b}`)}
            </Link>
          ))}
        </nav>
      ) : null}
      <BazarEntryForm sheet={sheet} />
      {catalogue && board === 'bazar' && <BazarCatalogueForm catalogue={catalogue} />}
      {sponsor && board === 'bazar' && <BazarSponsorForm sponsor={sponsor.sponsor} />}
    </>
  );
}
