import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { jsonLdScript, organizationJsonLd, webSiteJsonLd } from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

export default async function HomePage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const origin = await currentOrigin();
  const t = await getTranslations('home');
  const tPlaceholder = await getTranslations('placeholder');

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(organizationJsonLd(tenant, origin), webSiteJsonLd(tenant, origin)),
        }}
      />

      <section>
        <h1 className="text-3xl font-semibold">{t('heading', { tenant: tenant.nameBn })}</h1>
        <p className="mt-3 text-muted-foreground">{t('body')}</p>
      </section>

      {tenant.enabledCategories.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">{t('categoriesHeading')}</h2>
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {tenant.enabledCategories.map((category) => (
              <li key={category.slug}>
                <a
                  href={`/category/${category.slug}`}
                  className="block rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted"
                >
                  {category.nameBn}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-10 text-muted-foreground">{tPlaceholder('comingSoon')}</p>
      )}
    </>
  );
}
