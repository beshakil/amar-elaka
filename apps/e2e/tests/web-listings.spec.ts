import type { Page } from '@playwright/test';
import { STORE_SLUG } from '../stub-api/fixtures';
import { expect, serverResponse, test, tenantUrl } from './support';

/**
 * The public listing pages (ADR 039): statuses decided before rendering,
 * Bengali titles, canonical URLs with the Bengali slug, JSON-LD, the per-tenant
 * sitemaps, and a seller's number that never reaches the page's HTML.
 */

const MIRPUR = 'mirpur.localhost:3001';
const TITLE = 'স্যামসাং গ্যালাক্সি A54 — প্রায় নতুন';
/** listingSlug(TITLE): Bengali kept (conjuncts intact), punctuation to hyphens. */
const SLUG = 'স্যামসাং-গ্যালাক্সি-a54-প্রায়-নতুন';
const PHONE_SPELLINGS = ['01711111111', '০১৭১১১১১১১১', '8801711111111'];
const DAY = 86_400_000;

async function jsonLd(page: Page): Promise<unknown[]> {
  return page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts.flatMap((s) => JSON.parse(s.textContent ?? 'null') as unknown),
    );
}

const canonicalPath = (id: string) => `/listing/${id}/${encodeURIComponent(SLUG)}`;

test.describe('listing page', () => {
  test('redirects to the canonical Bengali slug and renders title, canonical and Product JSON-LD', async ({
    page,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const id = posts[0]!.id;

    const response = await page.goto(tenantUrl('mirpur', `/listing/${id}`));
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`http://${MIRPUR}${canonicalPath(id)}`);

    await expect(page).toHaveTitle(`${TITLE} — ১৫,০০০ টাকা | মিরপুর ১০, মিরপুর`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://${MIRPUR}${canonicalPath(id)}`,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /১৫,০০০ টাকা। মিরপুর ১০, মিরপুর/,
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`/og/listing/${id}\\?v=`),
    );

    const blocks = await jsonLd(page);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        '@type': 'Product',
        name: TITLE,
        itemCondition: 'https://schema.org/UsedCondition',
        offers: expect.objectContaining({
          price: '15000.00',
          priceCurrency: 'BDT',
          availability: 'https://schema.org/InStock',
        }),
      }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        '@type': 'BreadcrumbList',
        itemListElement: expect.arrayContaining([
          expect.objectContaining({ item: `http://${MIRPUR}/category/mobile-phones` }),
        ]),
      }),
    );
  });

  test('a wrong slug 308s to the right one', async ({ request, stub }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const id = posts[0]!.id;
    const res = await request.get(`http://127.0.0.1:3001/listing/${id}/old-title`, {
      headers: { host: MIRPUR },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(308);
    expect(res.headers().location).toBe(`http://${MIRPUR}${canonicalPath(id)}`);
  });

  test("another tenant's listing 308s to its own host", async ({ request, stub }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const id = posts[0]!.id;
    const res = await request.get(`http://127.0.0.1:3001${canonicalPath(id)}`, {
      headers: { host: 'savar.localhost:3001' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(308);
    expect(res.headers().location).toBe(`http://${MIRPUR}${canonicalPath(id)}`);
  });

  test("the seller's number is never in the HTML; a tap reveals it and records one lead", async ({
    page,
    request,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const id = posts[0]!.id;

    const { status, body } = await serverResponse(request, MIRPUR, canonicalPath(id));
    expect(status).toBe(200);
    for (const spelling of PHONE_SPELLINGS) expect(body).not.toContain(spelling);

    await page.goto(tenantUrl('mirpur', canonicalPath(id)));
    await expect(page.getByTestId('revealed-number')).toHaveCount(0);
    await page.getByRole('button', { name: 'নম্বর দেখুন' }).click();
    await expect(page.getByTestId('revealed-number')).toContainText('০১৭১১১১১১১১');
    await expect(page.getByTestId('revealed-number').getByRole('link')).toHaveAttribute(
      'href',
      'tel:+8801711111111',
    );
    expect(await stub.hits('POST /api/v1/posts/:id/contact')).toBe(1);
  });

  test('expired and removed listings answer 410 Gone, in Bengali, noindex', async ({
    request,
    page,
    stub,
  }) => {
    const { posts } = await stub.control({
      seedPosts: [
        { title: 'পুরোনো ল্যাপটপ', status: 'expired' },
        { title: 'নিষিদ্ধ জিনিস', status: 'removed' },
      ],
    });
    for (const post of posts) {
      const { status, body } = await serverResponse(request, MIRPUR, `/listing/${post.id}`);
      expect(status).toBe(410);
      expect(body).toContain('বিজ্ঞাপনটি আর নেই');
      expect(body).not.toContain(post.title);
    }
    await page.goto(tenantUrl('mirpur', `/listing/${posts[0]!.id}/x`));
    // Next adds its own noindex to an error status beside the page's: every one says noindex.
    const robots = await page
      .locator('meta[name="robots"]')
      .evaluateAll((tags) => tags.map((t) => t.getAttribute('content')));
    expect(robots.length).toBeGreaterThan(0);
    for (const content of robots) expect(content).toMatch(/noindex/);
  });

  test('a never-public listing or an unknown id is a real 404', async ({ request, stub }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: 'খসড়া', status: 'pending' }] });
    for (const path of [
      `/listing/${posts[0]!.id}`,
      '/listing/0191e3a0-0000-7000-8000-00000000ffff',
      '/listing/not-a-uuid',
    ]) {
      expect((await serverResponse(request, MIRPUR, path)).status).toBe(404);
    }
  });

  test('a sold listing keeps its page, marked sold; noindex once past sold_noindex_days', async ({
    page,
    stub,
  }) => {
    const { posts } = await stub.control({
      seedPosts: [
        {
          title: 'সদ্য বিক্রি',
          status: 'sold',
          isSold: true,
          soldAt: new Date(Date.now() - 2 * DAY).toISOString(),
        },
        {
          title: 'অনেক আগে বিক্রি',
          status: 'sold',
          isSold: true,
          soldAt: new Date(Date.now() - 120 * DAY).toISOString(),
        },
      ],
    });
    const [recent, old] = posts;

    await page.goto(tenantUrl('mirpur', `/listing/${recent!.id}`));
    await expect(page).toHaveTitle(/\(বিক্রি হয়ে গেছে\)$/);
    await expect(page.getByTestId('sold-note')).toBeVisible();
    await expect(page.getByText('বিক্রি হয়ে গেছে — যোগাযোগ বন্ধ।')).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    expect(await jsonLd(page)).toContainEqual(
      expect.objectContaining({
        offers: expect.objectContaining({ availability: 'https://schema.org/SoldOut' }),
      }),
    );

    const response = await page.goto(tenantUrl('mirpur', `/listing/${old!.id}`));
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
  });

  test('the share image is served from the tenant host as a PNG', async ({ request, stub }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const res = await request.get(`http://127.0.0.1:3001/og/listing/${posts[0]!.id}?v=1`, {
      headers: { host: MIRPUR },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['cache-control']).toContain('public');
  });
});

test.describe('category page', () => {
  test('lists the area’s listings with a Bengali title and ItemList JSON-LD', async ({
    page,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const href = canonicalPath(posts[0]!.id);
    // The page's data is cached for the tenant's window: the first view may be
    // stale (an earlier test's post), so wait for this one's link.
    await expect(async () => {
      await page.goto(tenantUrl('mirpur', '/category/mobile-phones'));
      await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(page).toHaveTitle('মোবাইল ফোন — মিরপুর-এর বিজ্ঞাপন | আমার এলাকা');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://${MIRPUR}/category/mobile-phones`,
    );
    expect(await jsonLd(page)).toContainEqual(
      expect.objectContaining({
        '@type': 'ItemList',
        itemListElement: [
          expect.objectContaining({
            position: 1,
            url: `http://${MIRPUR}${href}`,
          }),
        ],
      }),
    );
  });

  test('filters go to the API and make the page noindex, canonical to the category', async ({
    page,
    stub,
  }) => {
    await page.goto(tenantUrl('mirpur', '/category/mobile-phones?f.condition.eq=used'));
    expect(JSON.parse((await stub.lastSearch())?.filters ?? 'null')).toEqual({
      condition: { eq: 'used' },
    });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://${MIRPUR}/category/mobile-phones`,
    );
  });

  test('numbered pages are their own URLs, linked prev/next', async ({ page, stub }) => {
    await stub.control({
      seedPosts: Array.from({ length: 21 }, (_, i) => ({ title: `ফোন ${i + 1}`, status: 'live' })),
    });
    await expect(async () => {
      await page.goto(tenantUrl('mirpur', '/category/mobile-phones?page=2'));
      // Newest first, 20 a page: page 2 holds the oldest.
      await expect(page.getByText('ফোন 1', { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass();
    await expect(page).toHaveTitle(/পাতা ২/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://${MIRPUR}/category/mobile-phones?page=2`,
    );
    await expect(page.locator('a[rel="prev"]')).toHaveAttribute(
      'href',
      /\/category\/mobile-phones$/,
    );
  });

  test('a category the area doesn’t have is a real 404', async ({ request }) => {
    expect((await serverResponse(request, MIRPUR, '/category/boats')).status).toBe(404);
  });
});

test.describe('store page', () => {
  test('shows the store with LocalBusiness JSON-LD and no phone', async ({
    page,
    request,
    stub,
  }) => {
    await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    await page.goto(tenantUrl('mirpur', `/store/${STORE_SLUG}`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('রহিম ইলেকট্রনিক্স');
    await expect(page).toHaveTitle('রহিম ইলেকট্রনিক্স — মিরপুর ১০, মিরপুর | আমার এলাকা');
    const blocks = await jsonLd(page);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        '@type': 'LocalBusiness',
        name: 'রহিম ইলেকট্রনিক্স',
        address: expect.objectContaining({ addressCountry: 'BD' }),
      }),
    );
    expect(blocks).toContainEqual(expect.objectContaining({ '@type': 'BreadcrumbList' }));

    const { body } = await serverResponse(request, MIRPUR, `/store/${STORE_SLUG}`);
    for (const spelling of PHONE_SPELLINGS) expect(body).not.toContain(spelling);
    expect(
      (await serverResponse(request, 'savar.localhost:3001', `/store/${STORE_SLUG}`)).status,
    ).toBe(404);
  });
});

test.describe('home page', () => {
  test('recent listings, the categories and today’s bazar prices', async ({ page, stub }) => {
    await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    await expect(async () => {
      await page.goto(tenantUrl('mirpur'));
      await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass();
    await expect(page).toHaveTitle('মিরপুর-এ কেনাবেচা, ভাড়া ও স্থানীয় তথ্য | আমার এলাকা');
    await expect(page.getByText('মোটা চাল')).toBeVisible();
    await expect(page.getByRole('link', { name: 'মোবাইল ফোন' }).first()).toBeVisible();
  });
});

test.describe('sitemaps', () => {
  test('an index per tenant: pages, live listings and stores, split above the per-file size', async ({
    request,
    stub,
  }) => {
    const { posts } = await stub.control({
      sitemapUrlsPerFile: 2,
      seedPosts: [
        { title: TITLE, status: 'live' },
        { title: 'দুই', status: 'live' },
        { title: 'তিন', status: 'live' },
        { title: 'খসড়া', status: 'pending' },
        {
          title: 'পুরোনো বিক্রি',
          status: 'sold',
          isSold: true,
          soldAt: new Date(Date.now() - 120 * DAY).toISOString(),
        },
      ],
    });
    const index = await serverResponse(request, MIRPUR, '/sitemap.xml');
    expect(index.status).toBe(200);
    const files = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(files).toEqual([
      `http://${MIRPUR}/sitemaps/pages.xml`,
      `http://${MIRPUR}/sitemaps/listings-0.xml`,
      `http://${MIRPUR}/sitemaps/listings-1.xml`,
      `http://${MIRPUR}/sitemaps/stores-0.xml`,
    ]);

    const pages = await serverResponse(request, MIRPUR, '/sitemaps/pages.xml');
    expect(pages.body).toContain(`<loc>http://${MIRPUR}/category/mobile-phones</loc>`);

    const listings = [
      (await serverResponse(request, MIRPUR, '/sitemaps/listings-0.xml')).body,
      (await serverResponse(request, MIRPUR, '/sitemaps/listings-1.xml')).body,
    ].join('');
    expect(listings.match(/<url>/g)).toHaveLength(3);
    expect(listings).toContain(`<loc>http://${MIRPUR}${canonicalPath(posts[0]!.id)}</loc>`);
    expect(listings).not.toContain(posts[3]!.id);
    expect(listings).not.toContain(posts[4]!.id);

    const stores = await serverResponse(request, MIRPUR, '/sitemaps/stores-0.xml');
    expect(stores.body).toContain(`<loc>http://${MIRPUR}/store/${STORE_SLUG}</loc>`);

    const savar = await serverResponse(request, 'savar.localhost:3001', '/sitemap.xml');
    expect(savar.body).not.toContain('stores-0');
    expect(savar.body).not.toContain('mirpur');
    expect((await serverResponse(request, MIRPUR, '/sitemaps/other.xml')).status).toBe(404);
  });
});
