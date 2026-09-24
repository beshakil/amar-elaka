import { getTranslations } from 'next-intl/server';
import { currentViewer } from '@/lib/auth/me';

export default async function OverviewPage() {
  const [viewer, t] = await Promise.all([currentViewer(), getTranslations('overview')]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">
          {t('welcome', { name: viewer.me.displayName })}
        </p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <dt className="text-sm text-muted-foreground">{t('roleLabel')}</dt>
          <dd className="mt-1 font-medium">
            {viewer.permissions.isPlatformAdmin
              ? t('platformAdmin')
              : (viewer.permissions.role ?? viewer.me.role)}
          </dd>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <dt className="text-sm text-muted-foreground">{t('permissionsLabel')}</dt>
          <dd className="mt-1 font-medium">{viewer.permissions.grants.length}</dd>
        </div>
      </dl>

      <p className="text-muted-foreground">{t('body')}</p>
    </div>
  );
}
