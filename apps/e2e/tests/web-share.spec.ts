import { expect, serverResponse, test, tenantUrl } from './support';

/** How WhatsApp's link preview asks: it reads the OG tags from the server's HTML. */
const CRAWLER = { 'user-agent': 'WhatsApp/2.24.1 A' };

/** The stub's share code: the post id's first 8 hex digits (stub-api/server.ts). */
const codeOf = (postId: string) => postId.replace(/-/g, '').slice(0, 8);

test.describe('share links (/s/:code)', () => {
  test('a shared post opens as a preview, without the seller’s number', async ({ page, stub }) => {
    const { posts } = await stub.control({
      seedPosts: [{ title: 'শেয়ার করা আইফোন', status: 'live', description: 'বক্স সহ' }],
    });
    const code = codeOf(posts[0]!.id);
    await page.goto(tenantUrl('mirpur', `/s/${code}`));

    await expect(page.getByRole('heading', { level: 1, name: 'শেয়ার করা আইফোন' })).toBeVisible();
    await expect(page.getByText('৳ ১৫,০০০ (আলোচনা সাপেক্ষে)')).toBeVisible();
    await expect(page.getByText('বক্স সহ')).toBeVisible();
    // The label and option of the post's own schema version.
    await expect(page.getByText('অবস্থা', { exact: true })).toBeVisible();
    await expect(page.getByText('ব্যবহৃত', { exact: true })).toBeVisible();
    await expect(page.getByText('বিশ্বস্ত বিক্রেতা')).toBeVisible();

    const body = await page.locator('body').innerText();
    for (const spelling of ['01711111111', '০১৭১১১১১১১১', '8801711111111']) {
      expect(body).not.toContain(spelling);
    }
  });

  test('unfurls into an OG card (title, price and area, canonical share URL)', async ({
    request,
    stub,
  }) => {
    const { posts } = await stub.control({
      seedPosts: [{ title: 'ওজি কার্ডের ফোন', status: 'live' }],
    });
    const code = codeOf(posts[0]!.id);
    const { status, body } = await serverResponse(
      request,
      'mirpur.localhost:3001',
      `/s/${code}`,
      CRAWLER,
    );
    expect(status).toBe(200);
    expect(body).toContain('<meta property="og:title" content="ওজি কার্ডের ফোন"');
    expect(body).toContain(
      `<meta property="og:url" content="http://mirpur.localhost:3001/s/${code}"`,
    );
    expect(body).toMatch(/<meta property="og:description" content="৳ ১৫,০০০[^"]*মিরপুর ১০/);
    expect(body).toContain('<meta property="og:site_name" content="আমার এলাকা"');
  });

  test('an unknown or retired link is the not-found page, kept out of the index', async ({
    page,
    request,
    stub,
  }) => {
    const { posts } = await stub.control({ seedPosts: [{ title: 'লুকানো', status: 'pending' }] });
    const retired = codeOf(posts[0]!.id);
    for (const path of ['/s/zzzzzzzz', `/s/${retired}`]) {
      // A soft 404: the root loading.tsx streams before the lookup fails.
      const { body } = await serverResponse(request, 'mirpur.localhost:3001', path, CRAWLER);
      expect(body).toContain('<meta name="robots" content="noindex"/>');
      expect(body).not.toContain('লুকানো');
    }
    await page.goto(tenantUrl('mirpur', `/s/${retired}`));
    await expect(page.getByRole('heading', { name: 'পাতাটি খুঁজে পাওয়া যায়নি' })).toBeVisible();
  });
});
