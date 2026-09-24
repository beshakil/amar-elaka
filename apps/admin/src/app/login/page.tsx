import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { tenantSummarySchema } from '@/lib/api/schemas';
import { LoginForm } from './login-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('login');
  return { title: t('title') };
}

export default async function LoginPage() {
  const t = await getTranslations('login');

  // Public endpoint (@AllowAnyTenant), so no session is needed to populate the
  // picker — which is the point: a token is scoped to one tenant, so the tenant
  // has to be chosen before there is a token at all.
  const tenants = await apiFetch({ path: '/tenants', schema: z.array(tenantSummarySchema) }).catch(
    () => [],
  );

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        <div className="mt-6">
          {tenants.length === 0 ? (
            <p className="text-sm text-destructive">{t('noTenants')}</p>
          ) : (
            <LoginForm
              tenants={tenants.map((tenant) => ({ value: tenant.id, label: tenant.nameBn }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
