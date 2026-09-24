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
    await expect(page).toHaveTitle('ইলেকট্রনিক্স | মিরপুর');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ইলেকট্রনিক্স');
  });

  test("/info shows the tenant's real emergency numbers as tap-to-call links", async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/info'));
    await expect(page.getByText('মিরপুর থানা')).toBeVisible();
    await expect(page.getByRole('link', { name: '+8801320000000' })).toHaveAttribute(
      'href',
      'tel:+8801320000000',
    );
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

  test('placeholder detail pages are noindex', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/listing/abc'));
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
  });

  test("the sitemap is per tenant and only lists that tenant's URLs", async ({ request }) => {
    const { body: mirpur } = await serverResponse(request, 'mirpur.localhost:3001', '/sitemap.xml');
    expect(mirpur).toContain('<loc>http://mirpur.localhost:3001/category/electronics</loc>');
    expect(mirpur).not.toContain('savar');

    const { body: savar } = await serverResponse(request, 'savar.localhost:3001', '/sitemap.xml');
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
    expect(robots).toContain('Disallow: /listing/');
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
