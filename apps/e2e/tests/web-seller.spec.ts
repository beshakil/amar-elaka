import { expect, signInSeller, test, tenantUrl } from './support';

/**
 * The Seller Web Panel (ADR 057): behind sign-in; the dashboard with its
 * Bengali summary and charts; the product table on the shared DataTable —
 * stock in place, bulk actions with a per-row result; the catalog link and
 * the counter card.
 */

const STORE_ID = '0191e3a0-0000-7000-8000-0000000051e0';
const PANEL = `/seller/${STORE_ID}`;

test.describe('seller panel', () => {
  test('is for signed-in sellers only', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/seller'));
    await expect(page).toHaveURL(/\/login\?next=%2Fseller/);
  });

  test('the dashboard: the summary line, the period switcher, the charts and top products', async ({
    page,
    stub,
  }) => {
    await stub.control({ seedPosts: [{ title: 'রহিমের মোবাইল', status: 'live' }] });
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/seller'));
    await expect(page).toHaveURL(tenantUrl('mirpur', PANEL));
    await expect(page.getByTestId('summary')).toHaveText(
      'গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।',
    );
    await expect(page.getByRole('link', { name: '৩০ দিন' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('img', { name: /গত ৩০ দিনে প্রতিদিন/ })).toBeVisible();
    await expect(page.getByText('আগের সময়ের চেয়ে ২৪% বেশি')).toBeVisible();
    await expect(page.getByRole('link', { name: 'রহিমের মোবাইল' })).toBeVisible();
  });

  test('products: stock in place, then hide two at once with a result per row', async ({
    page,
    stub,
  }) => {
    await stub.control({
      seedPosts: [
        { title: 'প্রথম পণ্য', status: 'live' },
        { title: 'দ্বিতীয় পণ্য', status: 'live' },
      ],
    });
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', `${PANEL}/products`));
    await expect(page.getByText('২টি পণ্য')).toBeVisible();

    await page.getByLabel('স্টক: প্রথম পণ্য').selectOption({ label: 'স্টকে নেই' });
    await expect.poll(() => stub.hits('POST /api/v1/posts/:id/stock')).toBe(1);

    await page.getByRole('checkbox', { name: 'সব সারি নির্বাচন করুন' }).check();
    await page.getByRole('button', { name: /^লুকান/ }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '২টি হয়েছে, ০টি হয়নি' }),
    ).toBeVisible();
    expect((await stub.posts()).every((post) => post.hiddenByOwner)).toBe(true);
    await expect(page.getByText('· লুকানো')).toHaveCount(2);
  });

  test('catalog and QR: the link, the two print PDFs and the preview', async ({ page }) => {
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', `${PANEL}/catalog`));
    await expect(page.getByLabel('ক্যাটালগ লিংক')).toHaveValue(
      'http://mirpur.localhost:3001/store/rahim-electronics/catalog',
    );
    await expect(page.getByRole('link', { name: 'A5 কার্ড (PDF)' })).toHaveAttribute(
      'href',
      `${PANEL}/files/counter-card-a5`,
    );
    const preview = page.getByRole('img', { name: 'কাউন্টার কার্ডের নমুনা' });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Fetched in the browser (its session cookie, its *.localhost resolution).
    const fetched = await page.evaluate(async (panel) => {
      const pdf = await fetch(`${panel}/files/counter-card-a5`);
      const unknown = await fetch(`${panel}/files/anything`);
      return { status: pdf.status, type: pdf.headers.get('content-type'), unknown: unknown.status };
    }, PANEL);
    expect(fetched).toEqual({ status: 200, type: 'application/pdf', unknown: 404 });
  });
});
