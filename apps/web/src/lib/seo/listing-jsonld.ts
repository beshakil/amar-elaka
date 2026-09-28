import type { PostDetail, StorePage, TenantConfig } from '../api/schemas';
import type { JsonLd } from './json-ld';

/**
 * Product + Offer for a listing (ADR 039). An Offer only with a price;
 * availability says sold. `itemCondition` from a `condition` field when it
 * is one of the schema.org values.
 */
export function productJsonLd(
  post: PostDetail,
  url: string,
  images: string[],
  tenant: TenantConfig,
): JsonLd {
  const condition = post.fields.find((f) => f.key === 'condition')?.value;
  const itemCondition =
    condition === 'new'
      ? 'https://schema.org/NewCondition'
      : condition === 'used'
        ? 'https://schema.org/UsedCondition'
        : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${url}#product`,
    name: post.title,
    ...(post.description ? { description: post.description } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    sku: post.id,
    category: post.category.name.bn ?? post.category.name.en ?? post.category.slug,
    ...(itemCondition ? { itemCondition } : {}),
    ...(post.price
      ? {
          offers: {
            '@type': 'Offer',
            url,
            price: post.price,
            priceCurrency: post.currency,
            availability: post.isSold ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
            ...(itemCondition ? { itemCondition } : {}),
            areaServed: {
              '@type': 'Place',
              name: [post.area?.bn, tenant.nameBn].filter(Boolean).join(', '),
            },
            ...(post.seller.name
              ? {
                  seller: {
                    '@type': post.seller.store ? 'Organization' : 'Person',
                    name: post.seller.store?.name.bn ?? post.seller.name,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/** LocalBusiness for a store page. */
export function localBusinessJsonLd(store: StorePage, url: string, tenant: TenantConfig): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${url}#business`,
    name: store.name.bn ?? store.name.en ?? store.slug,
    url,
    ...(store.description ? { description: store.description } : {}),
    ...((store.cover ?? store.logo) ? { image: (store.cover ?? store.logo)!.url } : {}),
    address: {
      '@type': 'PostalAddress',
      ...(store.addressText ? { streetAddress: store.addressText } : {}),
      addressLocality: store.area?.bn ?? tenant.nameBn,
      addressRegion: tenant.nameBn,
      addressCountry: 'BD',
    },
    ...(store.location
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: store.location.lat,
            longitude: store.location.lng,
          },
        }
      : {}),
    ...(store.rating !== null && store.ratingCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: store.rating,
            reviewCount: store.ratingCount,
          },
        }
      : {}),
  };
}

/** ItemList for a category page: the listings on this page, in order. */
export function itemListJsonLd(
  items: { url: string; name: string }[],
  startPosition: number,
): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: startPosition + index,
      url: item.url,
      name: item.name,
    })),
  };
}
