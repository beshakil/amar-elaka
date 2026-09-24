import { getTranslations } from 'next-intl/server';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { apiFetch } from '@/lib/api/fetch';
import { tenantSummarySchema } from '@/lib/api/schemas';
import { currentViewer } from '@/lib/auth/me';
import { visibleNav } from '@/lib/nav/nav';
import { readUiPreferences } from '@/lib/ui-preferences';
import { z } from 'zod';

/**
 * The shell every dashboard route renders inside. It resolves the viewer once
 * here — the nav set, the nav items within it and the topbar all read from that
 * single pair of API calls rather than each fetching their own.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [viewer, { sidebarCollapsed, theme }, t] = await Promise.all([
    currentViewer(),
    readUiPreferences(),
    getTranslations('overview'),
  ]);

  const tenants = await apiFetch({
    path: '/tenants',
    schema: z.array(tenantSummarySchema),
    tenantId: viewer.session.tenantId,
    accessToken: viewer.session.accessToken,
  }).catch(() => []);

  const tenantName =
    tenants.find((tenant) => tenant.id === viewer.session.tenantId)?.nameBn ?? viewer.me.tenantId;

  return (
    <div className="flex min-h-dvh">
      <Sidebar items={visibleNav(viewer.permissions)} collapsed={sidebarCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          displayName={viewer.me.displayName}
          roleLabel={viewer.permissions.isPlatformAdmin ? t('platformAdmin') : t('tenantAdmin')}
          tenantName={tenantName}
          theme={theme}
        />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
