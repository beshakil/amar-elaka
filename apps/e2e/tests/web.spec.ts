import { TENANT_MIRPUR } from '../stub-api/fixtures';
import { expect, serverResponse, test, tenantUrl } from './support';

// The web app caches each hostname's tenant resolution for a minute, so tests
// that need an uncached hostname use one no other test touches.
const freshHost = (label: string) => tenantUrl(`${label}-${Date.now()}`);

test.describe('tenant resolution', () => {
  test('a tenant subdomain renders that tenant, in Bengali, on the server', async ({ page }) => {
    const response = await page.goto(tenantUrl('mirpur'));
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('মিরপুর-এর জন্য স্বাগতম');
    await expect(page.getByRole('link', { name: 'ইলেকট্রনিক্স' })).toBeVisible();
  });

  test('another subdomain is another tenant', async ({ page }) => {
    await page.goto(tenantUrl('savar'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('সাভার-এর জন্য স্বাগতম');
  });

  test("a tenant's custom domain resolves to it", async ({ page }) => {
    await page.goto('http://mirpur-bazaar.test:3001/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('মিরপুর-এর জন্য স্বাগতম');
  });

  test('an unknown subdomain gets the no-coverage page, pointing at the area list', async ({
    page,
  }) => {
    await page.goto(tenantUrl('nowhere'));
    await expect(
      page.getByRole('heading', { name: 'এই ঠিকানায় কোনো এলাকা খুঁজে পাওয়া যায়নি' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'এলাকার তালিকা দেখুন' }).click();
    await expect(page).toHaveURL(/\/areas$/);
  });

  test('a client-supplied x-tenant-id header is ignored', async ({ request }) => {
    const { body: html } = await serverResponse(request, 'nowhere.localhost:3001', '/', {
      'x-tenant-id': TENANT_MIRPUR,
      'x-tenant-resolution': 'resolved',
    });
    expect(html).toContain('এই ঠিকানায় কোনো এলাকা খুঁজে পাওয়া যায়নি');
    expect(html).not.toContain('মিরপুর-এর জন্য স্বাগতম');
  });

  test('the area switcher moves between tenant subdomains', async ({ page }) => {
    await page.goto(tenantUrl('mirpur'));
    await page.getByRole('link', { name: 'এলাকা পরিবর্তন করুন' }).click();
    await expect(page.getByRole('heading', { name: 'আপনার এলাকা বেছে নিন' })).toBeVisible();
    await expect(page.getByRole('link', { name: /মিরপুর/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await page.getByRole('link', { name: 'সাভার' }).click();
    await expect(page).toHaveURL('http://savar.localhost:3001/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('সাভার-এর জন্য স্বাগতম');
  });
});

test.describe('pages', () => {
  test('category pages use the tenant category name', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/category/electronics'));
    await expect(page).toHaveTitle('ইলেকট্রনিক্স — মিরপুর-এর বিজ্ঞাপন | আমার এলাকা');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ইলেকট্রনিক্স');
  });

  test("/info shows the area's emergency numbers as tap-to-call links", async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/info'));
    await expect(page.getByText('মিরপুর থানা')).toBeVisible();
    // Bengali digits on screen, the dialable number in the link (ADR 064).
    await expect(page.getByRole('link', { name: '+৮৮০১৩২০০০০০০০' })).toHaveAttribute(
      'href',
      'tel:+8801320000000',
    );
    await expect(page.getByRole('link', { name: /জাতীয় জরুরি সেবা/ })).toHaveAttribute(
      'href',
      'tel:999',
    );
  });

  test('/info/bazar shows the board with the stale banner and the sponsor', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/info/bazar'));
    await expect(page.getByRole('heading', { level: 1, name: 'আজকের বাজারদর' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('status')).toContainText(
      'আজকের দর এখনো দেওয়া হয়নি',
    );
    await expect(page.getByText('সৌজন্যে: রহিম স্টোর')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'মোটা চাল' })).toBeVisible();
  });

  test('the info engine: hub tiles, a notice list and detail, a route, prayer times', async ({
    page,
  }) => {
    await page.goto(tenantUrl('mirpur', '/info'));
    await expect(page.getByRole('link', { name: /নামাজের সময়/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /হারানো ও প্রাপ্তি/ })).toBeVisible();

    await page.goto(tenantUrl('mirpur', '/info/notices?category=local'));
    const notice = page.getByRole('link', { name: /পৌরসভার কর পরিশোধের নোটিশ/ });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('৮২০ মি দূরে');
    await notice.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('পৌরসভার কর পরিশোধের নোটিশ');
    await expect(page.getByText('প্রকাশক: মিরপুর পৌরসভা')).toBeVisible();

    await page.goto(tenantUrl('mirpur', '/info/transport'));
    // Past its window: "may be out of date".
    await expect(page.getByText('তথ্য পুরোনো হতে পারে')).toBeVisible();
    await page.getByRole('link', { name: /মিরপুর – গুলিস্তান বাস/ }).click();
    await expect(page.getByText('৳ ৩০ – ৳ ৪৫', { exact: false })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'পরের ছাড়ার সময়' })).toBeVisible();

    await page.goto(tenantUrl('mirpur', '/info/prayer'));
    await expect(page.getByTestId('next-prayer')).toContainText('পরের ওয়াক্ত');
    await expect(page.getByText('ফজর', { exact: true })).toBeVisible();
  });

  test('the home page carries the prayer card and info cards', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/'));
    await expect(page.getByRole('link', { name: /নামাজের সময়/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /পৌরসভার কর পরিশোধের নোটিশ/ })).toBeVisible();
  });

  test('an unknown path is a Bengali 404', async ({ page }) => {
    const response = await page.goto(tenantUrl('mirpur', '/does-not-exist'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'পাতাটি খুঁজে পাওয়া যায়নি' })).toBeVisible();
  });
});

test.describe('theme', () => {
  test('dark mode is chosen in the UI, and later pages arrive dark from the server — no flash', async ({
    page,
  }) => {
    await page.goto(tenantUrl('mirpur'));
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');

    await page.getByRole('button', { name: 'ডার্ক' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'ডার্ক' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The server's own HTML for a fresh page load, before any script runs.
    const response = await page.goto(tenantUrl('mirpur', '/map'));
    expect(await response?.text()).toMatch(/<html[^>]*data-theme="dark"/);
  });
});

test.describe('SEO', () => {
  test("canonical URL and JSON-LD name the tenant's own host", async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/category/electronics'));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'http://mirpur.localhost:3001/category/electronics',
    );
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((scripts) =>
        scripts.flatMap((s) => JSON.parse(s.textContent ?? 'null') as unknown),
      );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        '@type': 'BreadcrumbList',
        itemListElement: expect.arrayContaining([
          expect.objectContaining({ item: 'http://mirpur.localhost:3001/category/electronics' }),
        ]),
      }),
    );
  });

  test('a custom domain is its own canonical host', async ({ page }) => {
    await page.goto('http://mirpur-bazaar.test:3001/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'http://mirpur-bazaar.test:3001',
    );
  });

  test("the sitemap is per tenant and only lists that tenant's URLs", async ({ request }) => {
    const { body: mirpur } = await serverResponse(request, 'mirpur.localhost:3001', '/sitemap.xml');
    expect(mirpur).toContain('<loc>http://mirpur.localhost:3001/sitemaps/pages.xml</loc>');
    expect(mirpur).not.toContain('savar');
    const { body: pages } = await serverResponse(
      request,
      'mirpur.localhost:3001',
      '/sitemaps/pages.xml',
    );
    expect(pages).toContain('<loc>http://mirpur.localhost:3001/category/electronics</loc>');

    const { body: savar } = await serverResponse(
      request,
      'savar.localhost:3001',
      '/sitemaps/pages.xml',
    );
    expect(savar).toContain('<loc>http://savar.localhost:3001/</loc>');

    const { body: unknown } = await serverResponse(
      request,
      'nowhere.localhost:3001',
      '/sitemap.xml',
    );
    expect(unknown).not.toContain('<loc>');
  });

  test("robots.txt points at the tenant's own sitemap", async ({ request }) => {
    const { body: robots } = await serverResponse(request, 'mirpur.localhost:3001', '/robots.txt');
    expect(robots).toContain('Sitemap: http://mirpur.localhost:3001/sitemap.xml');
    // Listings and stores are the content; sign-in and seller pages are not.
    expect(robots).not.toContain('Disallow: /listing');
    expect(robots).toContain('Disallow: /me/');
  });
});

test.describe('when the API is down', () => {
  test('an unresolved host shows a retry — not "no coverage" — and retry recovers', async ({
    page,
    stub,
  }) => {
    const url = freshHost('outage');
    await stub.control({ down: true });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'কিছু একটা ভুল হয়েছে' })).toBeVisible();
    await expect(page.getByText('এই ঠিকানায় কোনো এলাকা খুঁজে পাওয়া যায়নি')).toHaveCount(0);
    // The site chrome still renders around the error.
    await expect(page.getByRole('link', { name: 'আমার এলাকা' })).toBeVisible();

    await stub.control({ down: false });
    await page.getByRole('button', { name: 'আবার চেষ্টা করুন' }).click();
    // The fixture hostname has no tenant, so a successful retry lands on the
    // no-coverage page — the API answered this time.
    await expect(
      page.getByRole('heading', { name: 'এই ঠিকানায় কোনো এলাকা খুঁজে পাওয়া যায়নি' }),
    ).toBeVisible();
  });

  test('a tenant already served keeps rendering from the cache', async ({ page, stub }) => {
    await page.goto(tenantUrl('mirpur'));
    await stub.control({ down: true });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('মিরপুর-এর জন্য স্বাগতম');
  });
});

test('tenant resolution is cached — repeat views of a host cost one API call', async ({
  page,
  stub,
}) => {
  const url = freshHost('cache');
  for (let i = 0; i < 3; i += 1) await page.goto(url);
  expect(await stub.hits('GET /api/v1/tenants/resolve')).toBe(1);
});
