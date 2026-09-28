import { describe, expect, it } from 'vitest';
import type { PostDetail, StorePage, TenantConfig } from '../api/schemas';
import { itemListJsonLd, localBusinessJsonLd, productJsonLd } from './listing-jsonld';

const tenant = { id: 't1', nameBn: 'মিরপুর' } as TenantConfig;
const URL_ = 'http://mirpur.localhost:3001/listing/p1/ফোন';

const post = (over: Partial<PostDetail> = {}) =>
  ({
    id: 'p1',
    title: 'পুরোনো ফোন',
    description: null,
    price: '15000.00',
    currency: 'BDT',
    isSold: false,
    category: { id: 'c1', slug: 'mobile-phones', name: { bn: 'মোবাইল ফোন', en: null } },
    fields: [
      { key: 'condition', type: 'select', label: { bn: 'অবস্থা', en: null }, value: 'used' },
    ],
    area: { bn: 'মিরপুর ১০', en: null },
    seller: { name: 'রহিম', store: null },
    contact: { name: 'রহিম', channels: ['call'], allowChat: true, loginRequired: false },
    ...over,
  }) as unknown as PostDetail;

describe('productJsonLd', () => {
  it('is a Product with an in-stock Offer in taka', () => {
    expect(productJsonLd(post(), URL_, ['http://img/1.webp'], tenant)).toMatchObject({
      '@type': 'Product',
      name: 'পুরোনো ফোন',
      image: ['http://img/1.webp'],
      category: 'মোবাইল ফোন',
      itemCondition: 'https://schema.org/UsedCondition',
      offers: {
        '@type': 'Offer',
        price: '15000.00',
        priceCurrency: 'BDT',
        availability: 'https://schema.org/InStock',
        areaServed: { name: 'মিরপুর ১০, মিরপুর' },
        seller: { '@type': 'Person', name: 'রহিম' },
      },
    });
  });

  it('says SoldOut for a sold listing, and has no Offer without a price', () => {
    expect(productJsonLd(post({ isSold: true }), URL_, [], tenant)).toMatchObject({
      offers: { availability: 'https://schema.org/SoldOut' },
    });
    const noPrice = productJsonLd(post({ price: null }), URL_, [], tenant);
    expect(noPrice).not.toHaveProperty('offers');
    expect(noPrice).not.toHaveProperty('image');
  });

  it('never carries a phone number', () => {
    expect(JSON.stringify(productJsonLd(post(), URL_, [], tenant))).not.toMatch(/telephone|\+880/);
  });
});

describe('localBusinessJsonLd', () => {
  it('addresses the store in Bangladesh with its coordinates', () => {
    const store = {
      slug: 'rahim',
      name: { bn: 'রহিম ইলেকট্রনিক্স', en: null },
      description: null,
      addressText: 'দোকান ১২',
      area: { bn: 'মিরপুর ১০', en: null },
      location: { lat: 23.8, lng: 90.36 },
      logo: null,
      cover: null,
    } as unknown as StorePage;
    expect(localBusinessJsonLd(store, 'http://x/store/rahim', tenant)).toMatchObject({
      '@type': 'LocalBusiness',
      name: 'রহিম ইলেকট্রনিক্স',
      address: { streetAddress: 'দোকান ১২', addressLocality: 'মিরপুর ১০', addressCountry: 'BD' },
      geo: { latitude: 23.8, longitude: 90.36 },
    });
  });
});

describe('itemListJsonLd', () => {
  it('numbers the items from the page’s first position', () => {
    const list = itemListJsonLd(
      [
        { url: 'http://x/a', name: 'ক' },
        { url: 'http://x/b', name: 'খ' },
      ],
      21,
    );
    expect(list).toMatchObject({
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 21, url: 'http://x/a', name: 'ক' },
        { '@type': 'ListItem', position: 22, url: 'http://x/b' },
      ],
    });
  });
});
