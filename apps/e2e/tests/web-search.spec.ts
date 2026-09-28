import { expect, serverResponse, signInSeller, test, tenantUrl } from './support';

/**
 * Search on the web (ADR 042): the header's suggestions, /search with its
 * state in the URL (shareable, back-button safe) and noindex, saving a
 * search, and the indexable category + area landing pages.
 */

const MIRPUR = 'mirpur.localhost:3001';
const SAMSUNG = 'স্যামসাং গ্যালাক্সি A54 — প্রায় নতুন';
const IPHONE = 'আইফোন ১৩ — ব্যবহৃত';

test.describe('header suggestions', () => {
  test('suggest as you type; the keyboard picks one; Enter alone searches the text', async ({
    page,
    stub,
  }) => {
    await stub.control({ seedPosts: [{ title: SAMSUNG }] });
    await page.goto(tenantUrl('mirpur', '/'));
    const box = page.getByRole('combobox', { name: 'খুঁজুন: ডাক্তার, basa vara, mobile…' });

    await box.fill('স্যামসাং');
    const list = page.getByRole('listbox');
    await expect(list.getByRole('option', { name: SAMSUNG })).toBeVisible();
    await expect(list.getByText('বিজ্ঞাপন')).toBeVisible();
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(list.getByRole('option', { name: SAMSUNG })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await box.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(SAMSUNG);

    // Esc closes; Enter with nothing chosen searches what was typed.
    await page.goto(tenantUrl('mirpur', '/'));
    await box.fill('mob');
    await expect(page.getByRole('listbox')).toBeVisible();
    await box.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await box.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=mob$/);
  });
});

test.describe('/search', () => {
  test('keeps its state in the URL: facets, sort and the back button', async ({ page, stub }) => {
    await stub.control({
      seedPosts: [
        { title: SAMSUNG, fields: { condition: 'new', price: '25000.00' }, price: '25000.00' },
        { title: `${SAMSUNG} ২`, fields: { condition: 'used', price: '15000.00' } },
        { title: IPHONE, fields: { condition: 'used', price: '15000.00' } },
      ],
    });
    await page.goto(tenantUrl('mirpur', `/search?q=${encodeURIComponent('স্যামসাং')}`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('“স্যামসাং”-এর ফলাফল');
    await expect(page.getByTestId('search-summary')).toHaveText(
      'প্রায় ২টি ফলাফল · ১০ কিমির মধ্যে',
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
    // The header box shows the text being searched.
    await expect(page.getByRole('combobox')).toHaveValue('স্যামসাং');

    // A facet is a link: the category (with its count), then a value of its field.
    await page.getByRole('link', { name: 'মোবাইল ফোন (২)' }).click();
    await expect(page).toHaveURL(/category=mobile-phones/);
    await page.getByRole('link', { name: 'ব্যবহৃত (১)' }).click();
    await expect(page).toHaveURL(/f\.condition\.in=used/);
    await expect(page.getByTestId('search-summary')).toHaveText(/প্রায় ১টি ফলাফল/);
    expect((await stub.searches()).lastSearch).toMatchObject({
      q: 'স্যামসাং',
      category: 'mobile-phones',
      filters: '{"condition":{"eq":"used"}}',
    });
    const filtered = page.url();

    // Sorting, then back: the filtered page as it was.
    await page.getByRole('link', { name: 'নতুন আগে' }).click();
    await expect(page).toHaveURL(/sort=newest/);
    await page.goBack();
    expect(page.url()).toBe(filtered);
    await expect(page.getByTestId('search-summary')).toHaveText(/প্রায় ১টি ফলাফল/);

    // A shared URL shows the same search.
    const shared = await page.context().newPage();
    await shared.goto(filtered);
    await expect(shared.getByTestId('search-summary')).toHaveText(/প্রায় ১টি ফলাফল/);

    // Removing a filter from its chip.
    await page.getByRole('link', { name: 'অবস্থা: ব্যবহৃত সরান' }).click();
    await expect(page).not.toHaveURL(/f\.condition/);

    // Facet, sort and page links don't invite crawlers into endless combinations.
    expect(await page.getByRole('link', { name: 'নতুন আগে' }).getAttribute('rel')).toBe('nofollow');
  });

  test('an empty result offers a way forward', async ({ page, stub }) => {
    await stub.control({ seedPosts: [{ title: IPHONE }] });
    await page.goto(
      tenantUrl(
        'mirpur',
        `/search?q=${encodeURIComponent('আইফোন')}&category=mobile-phones&price_min=40000`,
      ),
    );
    const empty = page.getByTestId('search-empty');
    await expect(empty.getByRole('heading')).toHaveText('“আইফোন”-এর জন্য কিছু পাওয়া যায়নি');
    await expect(empty.getByRole('link', { name: '“৳ ৪০,০০০+” ছাড়া খুঁজুন' })).toBeVisible();
    await empty.getByRole('link', { name: '“৳ ৪০,০০০+” ছাড়া খুঁজুন' }).click();
    await expect(page.getByRole('link', { name: IPHONE })).toBeVisible();
  });

  test('a guest is asked to sign in to save; a seller saves the search as shown', async ({
    page,
    stub,
  }) => {
    await stub.control({ seedPosts: [{ title: SAMSUNG }] });
    const path = `/search?q=${encodeURIComponent('স্যামসাং')}&category=mobile-phones&price_min=10000&price_max=20000`;
    await page.goto(tenantUrl('mirpur', path));
    const login = page.getByRole('link', { name: 'সার্চ সেভ করতে লগইন করুন' });
    await expect(login).toHaveAttribute('href', /^\/login\?next=%2Fsearch%3Fq%3D/);

    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', path));
    await page.getByText('এই সার্চ সেভ করুন').click();
    await page.getByLabel('দিনে একবার').check();
    await page.getByRole('button', { name: 'সেভ করুন' }).click();

    // Post → redirect → get: the same search, with the confirmation.
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      'সার্চ সেভ হয়েছে — নতুন কিছু এলে জানাব।',
    );
    await expect(page).toHaveURL(/q=.+&category=mobile-phones.*saved=1/);
    const { savedSearches } = await stub.searches();
    expect(savedSearches).toEqual([
      {
        name: 'স্যামসাং',
        q: 'স্যামসাং',
        filters: { category: 'mobile-phones', price_min: '10000', price_max: '20000' },
        center: expect.objectContaining({ lat: expect.any(Number) }),
        radius_km: 10,
        frequency: 'daily',
      },
    ]);

    // At the active-search limit: said so, in Bengali.
    await stub.control({ savedSearchLimit: true });
    await page.goto(tenantUrl('mirpur', path));
    await page.getByText('এই সার্চ সেভ করুন').click();
    await page.getByRole('button', { name: 'সেভ করুন' }).click();
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      /একসাথে সর্বোচ্চ ৫টি সার্চ চালু রাখা যায়/,
    );
  });
});

test.describe('category + area landing pages', () => {
  test('exist where the area has enough listings, and are built to rank', async ({
    page,
    request,
    stub,
  }) => {
    await stub.control({ seedPosts: [{ title: SAMSUNG }, { title: IPHONE }] });
    const response = await page.goto(tenantUrl('mirpur', '/category/mobile-phones/mirpur-10'));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('মিরপুর ১০-এ মোবাইল ফোন — মিরপুর | আমার এলাকা');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('মিরপুর ১০-এ মোবাইল ফোন');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://${MIRPUR}/category/mobile-phones/mirpur-10`,
    );
    await expect(page.getByRole('link', { name: SAMSUNG })).toBeVisible();
    expect((await stub.searches()).lastSearch).toMatchObject({
      category: 'mobile-phones',
      area: 'mirpur-10',
      sort: 'newest',
    });

    // Linked from the category page, and in the sitemap.
    await page.goto(tenantUrl('mirpur', '/category/mobile-phones'));
    await page.getByRole('link', { name: 'মিরপুর ১০ (২)' }).click();
    await expect(page).toHaveURL(/\/category\/mobile-phones\/mirpur-10$/);
    const sitemap = await serverResponse(request, MIRPUR, '/sitemaps/pages.xml');
    expect(sitemap.body).toContain(`http://${MIRPUR}/category/mobile-phones/mirpur-10`);

    // An unknown area: 404. So is an area below the threshold — here Savar,
    // with no listings (the gate's list is per tenant).
    expect((await serverResponse(request, MIRPUR, '/category/mobile-phones/nowhere')).status).toBe(
      404,
    );
    expect(
      (await serverResponse(request, 'savar.localhost:3001', '/category/mobile-phones/mirpur-10'))
        .status,
    ).toBe(404);
  });
});
