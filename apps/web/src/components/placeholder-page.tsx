import { getTranslations } from 'next-intl/server';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { currentOrigin } from '@/lib/tenant';

/**
 * The body every not-yet-built route renders. Real pages replace it wholesale;
 * until then each route still carries its own metadata and breadcrumbs, so the
 * SEO wiring is exercised rather than waiting for the feature.
 */
export async function PlaceholderPage({
  title,
  body,
  breadcrumbs,
}: {
  title: string;
  body: string;
  breadcrumbs: { name: string; path: string }[];
}) {
  const t = await getTranslations('placeholder');
  const origin = await currentOrigin();

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumbJsonLd(breadcrumbs, origin)) }}
      />
      <section>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-muted-foreground">{body}</p>
        <p className="mt-6 inline-block rounded-md bg-muted px-3 py-1 text-sm text-muted-foreground">
          {t('comingSoon')}
        </p>
      </section>
    </>
  );
}
