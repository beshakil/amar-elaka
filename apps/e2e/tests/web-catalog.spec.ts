import type { Page } from '@playwright/test';
import { STORE_SLUG } from '../stub-api/fixtures';
import { expect, serverResponse, test, tenantUrl } from './support';

/**
 * The WhatsApp catalog (ADR 056): a light page of the store's products whose
 * HTML never carries a phone number; "WhatsApp-এ অর্ডার" posts to this site,
 * which records the lead with the API and only then redirects to wa.me.
 */

const MIRPUR = 'mirpur.localhost:3001';
const TITLE = 'স্যামসাং গ্যালাক্সি A54 — প্রায় নতুন';
const PHONE_SPELLINGS = ['01711111111', '০১৭১১১১১১১১', '8801711111111', 'wa.me'];
const CATALOG = `/store/${STORE_SLUG}/catalog`;

/** The catalog page once it shows this run's product (the web serves a stale copy while it revalidates). */
async function openCatalog(page: Page, postId: string): Promise<void> {
  await expect(async () => {
    await page.goto(tenantUrl('mirpur', CATALOG));
    await expect(page.locator(`[id="p-${postId}"]`)).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test.describe('store catalog', () => {
  test('lists the products with an order button, a share card, and never a phone number', async ({
    page,
    request,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    const id = posts[0]!.id;

    let body = '';
    await expect(async () => {
      const response = await serverResponse(request, MIRPUR, CATALOG);
      expect(response.status).toBe(200);
      body = response.body;
      expect(body).toContain(`action="${CATALOG}/order/${id}"`);
    }).toPass();
    for (const spelling of PHONE_SPELLINGS) expect(body).not.toContain(spelling);

    await openCatalog(page, id);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('রহিম ইলেকট্রনিক্স');
    await expect(page.getByText(TITLE)).toBeVisible();
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      `http://${MIRPUR}/og/store/${STORE_SLUG}`,
    );
    const card = await request.get(`http://127.0.0.1:3001/og/store/${STORE_SLUG}`, {
      headers: { host: MIRPUR },
    });
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toBe('image/png');

    expect((await serverResponse(request, 'savar.localhost:3001', CATALOG)).status).toBe(404);
  });

  test('ordering records the lead first, then opens WhatsApp with the product named', async ({
    page,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    // The order route answers with a redirect to WhatsApp: keep its Location, don't leave the test.
    let whatsapp: URL | null = null;
    await page.route(`**${CATALOG}/order/*`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(303);
      whatsapp = new URL(response.headers()['location'] ?? '');
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>whatsapp</p>' });
    });

    await openCatalog(page, posts[0]!.id);
    await page
      .locator(`[id="p-${posts[0]!.id}"]`)
      .getByRole('button', { name: 'WhatsApp-এ অর্ডার' })
      .click();
    await expect.poll(() => whatsapp?.searchParams.get('text') ?? null).toContain(TITLE);
    expect(whatsapp!.origin).toBe('https://wa.me');
    expect(await stub.hits(`POST /api/v1/stores/${STORE_SLUG}/catalog/order/:id`)).toBe(1);
  });

  test('a product that is gone sends the buyer back with a notice', async ({ page, stub }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: TITLE, status: 'live' }] });
    await openCatalog(page, posts[0]!.id);
    // Sold between the page loading and the tap.
    await stub.control({ reset: true });
    await page
      .locator(`[id="p-${posts[0]!.id}"]`)
      .getByRole('button', { name: 'WhatsApp-এ অর্ডার' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${CATALOG}\\?order=gone#p-${posts[0]!.id}$`));
    await expect(
      page.getByRole('alert').filter({ hasText: 'পণ্যটি আর পাওয়া যাচ্ছে না।' }),
    ).toBeVisible();
  });
});
