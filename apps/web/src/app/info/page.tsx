import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { PlaceholderPage } from '@/components/placeholder-page';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('nav')]);
  return {
    title: t('info'),
    description: tenant?.nameBn,
    alternates: { canonical: '/info' },
  };
}

export default async function InfoPage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('info');
  const tNav = await getTranslations('nav');
  const tPlaceholder = await getTranslations('placeholder');
  const breadcrumbs = [
    { name: tNav('home'), path: '/' },
    { name: tNav('info'), path: '/info' },
  ];

  // Emergency numbers and support contacts are the one part of this page the
  // tenant config already carries, so they render for real rather than as a
  // placeholder.
  const hasSupport = tenant.support.phoneE164 !== null || tenant.support.email !== null;
  if (tenant.emergencyNumbers.length === 0 && !hasSupport) {
    return (
      <PlaceholderPage title={tNav('info')} body={tPlaceholder('info')} breadcrumbs={breadcrumbs} />
    );
  }

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(breadcrumbJsonLd(breadcrumbs, await currentOrigin())),
        }}
      />
      <h1 className="text-2xl font-semibold">{tNav('info')}</h1>

      {tenant.emergencyNumbers.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">{t('emergencyHeading')}</h2>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
            {tenant.emergencyNumbers.map((contact) => (
              <li
                key={`${contact.serviceType}-${contact.nameBn}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <span>
                  {contact.nameBn}
                  {contact.is24h ? (
                    <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t('hours24')}
                    </span>
                  ) : null}
                </span>
                <span className="flex gap-3">
                  {contact.phones.map((phone) => (
                    <a key={phone} href={`tel:${phone}`} className="text-brand hover:underline">
                      {phone}
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasSupport ? (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">{t('supportHeading')}</h2>
          <ul className="mt-4 space-y-2">
            {tenant.support.phoneE164 ? (
              <li>
                <a href={`tel:${tenant.support.phoneE164}`} className="text-brand hover:underline">
                  {tenant.support.phoneE164}
                </a>
              </li>
            ) : null}
            {tenant.support.email ? (
              <li>
                <a href={`mailto:${tenant.support.email}`} className="text-brand hover:underline">
                  {tenant.support.email}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}
