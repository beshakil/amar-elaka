'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, dataTableColumnHelper } from '@/components/data-table/data-table';
import type { TenantSummary } from '@/lib/api/schemas';

/**
 * Read-only: the API has no tenant create/update endpoint, so this is a plain
 * DataTable rather than a CrudPage with buttons that could not do anything.
 */
export function TenantsClient({ tenants }: { tenants: TenantSummary[] }) {
  const t = useTranslations('tenants');

  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<TenantSummary>();
    return helper.columns([
      helper.accessor('nameBn', { header: t('nameBn') }),
      helper.accessor('nameEn', { header: t('nameEn') }),
      helper.accessor('slug', { header: t('slug') }),
      helper.accessor((tenant) => tenant.districtNameBn ?? '—', {
        id: 'district',
        header: t('district'),
      }),
    ]);
  }, [t]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('description')}</p>
      </div>
      <DataTable
        columns={columns}
        data={tenants}
        getRowId={(tenant) => tenant.id}
        exportFilename="tenants"
      />
    </div>
  );
}
