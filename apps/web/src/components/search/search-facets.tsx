import { formatMoney, localizeDigits, optionLabel, labelOf } from '@amar-elaka/dynamic-form';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import type { SearchFacets as Facets } from '@/lib/api/schemas';
import { isChosen, searchHref, toggleValue, type SearchParams } from '@/lib/search/params';
import { cn } from '@/lib/utils';

export interface FacetLabels {
  category: string;
  allCategories: string;
  price: string;
  anyPrice: string;
  facet: (label: string, count: string) => string;
  priceRange: (min: string, max: string | null) => string;
  categoryName: (slug: string) => string;
}

/**
 * The filters, built from the answer's facets: every choice is a link with
 * its count. Links, not controls — each is a URL (shareable, back-safe,
 * works without JavaScript). rel="nofollow": the combinations are endless
 * and the pages are noindex, so crawlers shouldn't spend time on them.
 */
export function SearchFacets({
  params,
  facets,
  schema,
  labels,
}: {
  params: SearchParams;
  facets: Facets;
  schema: CategoryFieldSchema | null;
  labels: FacetLabels;
}) {
  const count = (n: number) => localizeDigits(String(n), 'bn');
  const valueFacets = Object.entries(facets.fields).flatMap(([field, facet]) =>
    facet.kind === 'values' && schema ? [{ field, values: facet.values }] : [],
  );
  const chosenCategoryMissing =
    params.category !== null && !facets.categories.some((c) => c.slug === params.category);

  return (
    <div className="space-y-5">
      <Section title={labels.category}>
        <Chip href={searchHref(params, { category: null })} active={params.category === null}>
          {labels.allCategories}
        </Chip>
        {chosenCategoryMissing && (
          <Chip href={searchHref(params, { category: null })} active>
            {labels.categoryName(params.category!)}
          </Chip>
        )}
        {facets.categories.map((c) => (
          <Chip
            key={c.slug}
            href={searchHref(params, {
              category: params.category === c.slug ? null : c.slug,
            })}
            active={params.category === c.slug}
          >
            {labels.facet(labels.categoryName(c.slug), count(c.count))}
          </Chip>
        ))}
      </Section>

      {facets.price && facets.price.buckets.length > 0 && (
        <Section title={labels.price}>
          <Chip
            href={searchHref(params, { priceMin: null, priceMax: null })}
            active={params.priceMin === null && params.priceMax === null}
          >
            {labels.anyPrice}
          </Chip>
          {facets.price.buckets.map((b) => {
            const active = samePrice(params.priceMin, b.min) && samePrice(params.priceMax, b.max);
            return (
              <Chip
                key={b.min}
                href={searchHref(
                  params,
                  active
                    ? { priceMin: null, priceMax: null }
                    : { priceMin: b.min, priceMax: b.max },
                )}
                active={active}
              >
                {labels.facet(
                  labels.priceRange(
                    formatMoney(b.min, 'bn'),
                    b.max === null ? null : formatMoney(b.max, 'bn'),
                  ),
                  count(b.count),
                )}
              </Chip>
            );
          })}
        </Section>
      )}

      {valueFacets.map(({ field, values }) => (
        <Section key={field} title={labelOf(schema!, field, 'bn')}>
          {values.map((v) => (
            <Chip
              key={v.value}
              href={searchHref(toggleValue(params, field, v.value), { page: 1 })}
              active={isChosen(params, field, v.value)}
            >
              {labels.facet(optionLabel(schema!, field, v.value, 'bn'), count(v.count))}
            </Chip>
          ))}
        </Section>
      ))}
    </div>
  );
}

/** "10000" and "10000.00" are the same price. */
function samePrice(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h2>
      <ul className="flex flex-wrap gap-2">{children}</ul>
    </section>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        rel="nofollow"
        aria-current={active ? 'true' : undefined}
        className={cn(
          'inline-block rounded-full border px-3 py-1 text-sm',
          active ? 'border-brand bg-brand text-brand-foreground' : 'border-border hover:bg-muted',
        )}
      >
        {children}
      </a>
    </li>
  );
}
