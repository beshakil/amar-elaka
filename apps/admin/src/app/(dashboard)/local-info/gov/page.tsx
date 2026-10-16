import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { govServiceDetailSchema, infoListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';
import { LocalInfoTabs } from '../local-info-tabs';
import { GovClient } from './gov-client';

/**
 * The government service guide (ADR 065): the area team writes each
 * service — office, hours, documents, fees, steps, official links. Every
 * save is a new version (the old ones stay readable); "checked today"
 * renews "last verified on" without a new version.
 */
export default async function GovAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const viewer = await requireRoles(LOCAL_INFO_ROLES);
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const { edit } = await searchParams;
  const editId = edit && /^[0-9a-f-]{36}$/.test(edit) ? edit : null;
  const [list, editing, t] = await Promise.all([
    apiFetch({ path: '/info/gov-services/manage', schema: infoListSchema, ...auth }),
    editId
      ? apiFetch({
          path: `/info/gov-services/${editId}`,
          schema: govServiceDetailSchema,
          ...auth,
        }).catch(() => null)
      : null,
    getTranslations('localInfo'),
  ]);
  return (
    <>
      <LocalInfoTabs active="gov" />
      <h1 className="mb-1 text-xl font-semibold">{t('gov.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('gov.description')}</p>
      {/* Keyed: opening another service starts a fresh form. */}
      <GovClient key={editing?.id ?? 'new'} services={list.items} editing={editing} />
    </>
  );
}
