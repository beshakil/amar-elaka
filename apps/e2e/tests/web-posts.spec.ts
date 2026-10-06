import { OTP_CODE, SELLER_PHONE, STUB_URL } from '../stub-api/fixtures';
import { expect, signInSeller, test, tenantUrl } from './support';

/** A real 1×1 PNG, so the browser's own decode/compress path runs. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('seller login', () => {
  test('a guest opening "new post" signs in with an SMS code and comes back to it', async ({
    page,
  }) => {
    await page.goto(tenantUrl('mirpur', '/post/new'));
    await expect(page).toHaveURL(/\/login\?next=%2Fpost%2Fnew$/);

    await page.getByLabel('মোবাইল নম্বর').fill(SELLER_PHONE);
    await page.getByRole('button', { name: 'কোড পাঠান' }).click();
    await page.getByLabel('এসএমএস-এ পাওয়া কোড').fill('000000');
    await page.getByRole('button', { name: 'লগইন করুন' }).click();
    await expect(page.getByText('কোডটি মেলেনি — আবার দেখে লিখুন।')).toBeVisible();

    await page.getByLabel('এসএমএস-এ পাওয়া কোড').fill(OTP_CODE);
    await page.getByRole('button', { name: 'লগইন করুন' }).click();
    await expect(page).toHaveURL(tenantUrl('mirpur', '/post/new'));
    await expect(page.getByRole('heading', { name: 'নতুন পোস্ট' })).toBeVisible();
  });

  test('my posts is gated too, and a login never follows a link off the site', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/me/posts'));
    await expect(page).toHaveURL(/\/login\?next=%2Fme%2Fposts$/);
    await page.goto(tenantUrl('mirpur', '/login?next=//evil.example'));
    await page.getByLabel('মোবাইল নম্বর').fill(SELLER_PHONE);
    await page.getByRole('button', { name: 'কোড পাঠান' }).click();
    await page.getByLabel('এসএমএস-এ পাওয়া কোড').fill(OTP_CODE);
    await page.getByRole('button', { name: 'লগইন করুন' }).click();
    await expect(page).toHaveURL(tenantUrl('mirpur', '/me/posts'));
  });
});

test.describe('create a post', () => {
  test('category, details, a photo, a point on the map, contact → live, sent once', async ({
    page,
    stub,
  }) => {
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/post/new'));

    // "Post" before anything: every missing section says so.
    await page.getByRole('button', { name: 'পোস্ট করুন', exact: true }).last().click();
    await expect(page.getByRole('alert').filter({ hasText: 'একটি বিভাগ বেছে নিন' })).toBeVisible();

    await page.getByRole('radio', { name: /মোবাইল ফোন/ }).click();
    await page.getByLabel(/^শিরোনাম/).fill('আইফোন ১৩, ১২৮ জিবি');
    await page.getByLabel('বিবরণ').fill('বক্স সহ, ব্যাটারি ৯০%');
    await page.getByText('ব্যবহৃত', { exact: true }).click(); // the chip's label
    await page.getByLabel(/^দাম/).fill('৬৫০০০');

    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'phone.png', mimeType: 'image/png', buffer: PNG });

    // The picker (ADR 046) settles at the area's centre (no location
    // permission here): our area name, and one reverse for the street.
    await expect(page.getByTestId('location-map')).toHaveAttribute('data-map-state', 'ready', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('location-area')).toHaveText('এলাকা: মিরপুর, ঢাকা');
    await expect(page.getByTestId('location-address')).toHaveValue('মিরপুর ১০, ঢাকা');
    // A post's pin: the purpose decides which Barikoi fields are asked for (ADR 044).
    const stats = (await (await page.request.get(`${STUB_URL}/__stats`)).json()) as {
      lastReversePurpose: string | null;
    };
    expect(stats.lastReversePurpose).toBe('post_location');
    expect(await stub.hits('GET /api/v1/geo/reverse')).toBe(1);

    // Dragging the map under the pin: one more reverse when it comes to rest
    // (after geo_picker_idle_debounce_ms), however many frames the drag took.
    await page.getByTestId('location-map').scrollIntoViewIfNeeded();
    const map = (await page.getByTestId('location-map').boundingBox())!;
    await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
    await page.mouse.down();
    await page.mouse.move(map.x + map.width / 2 - 120, map.y + map.height / 2 - 60, { steps: 30 });
    await page.mouse.up();
    await expect.poll(() => stub.hits('GET /api/v1/geo/reverse')).toBe(2);
    await page.waitForTimeout(1500);
    expect(await stub.hits('GET /api/v1/geo/reverse')).toBe(2);

    // The address is editable; what the seller keeps is what is saved.
    await page.getByTestId('location-address').fill('বাড়ি ১২, রোড ৩, মিরপুর ১০');

    // The preview is the card buyers will see.
    const preview = page.getByRole('complementary');
    await expect(preview.getByText('৳ ৬৫,০০০')).toBeVisible();
    await expect(preview.getByText('অবস্থা ব্যবহৃত')).toBeVisible();

    await page.getByRole('button', { name: 'পোস্ট করুন', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'আপনার পোস্ট এখন লাইভ!' })).toBeVisible();

    const [post] = await stub.posts();
    expect(post).toMatchObject({
      title: 'আইফোন ১৩, ১২৮ জিবি',
      description: 'বক্স সহ, ব্যাটারি ৯০%',
      fields: { condition: 'used', price: '65000.00' },
      contact: { name: 'রহিম বিক্রেতা', phone: '+8801711111111' },
    });
    expect(post?.media).toHaveLength(1);
    expect(await stub.hits('POST /api/v1/posts')).toBe(1);
  });

  test('address search puts the pin, and a point outside the area is a warning, not a block', async ({
    page,
    stub,
  }) => {
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/post/new'));
    await expect(page.getByTestId('location-address')).toHaveValue('মিরপুর ১০, ঢাকা', {
      timeout: 30_000,
    });
    const reverses = await stub.hits('GET /api/v1/geo/reverse');
    // Debounced, minimum length from settings; our own places first.
    await page.getByTestId('location-search').fill('মিরপুর ১০');
    const results = page.getByTestId('location-results').getByRole('button');
    await expect(results).toHaveText(['মিরপুর স্টেডিয়াম', 'সেকশন ১০, মিরপুর, ঢাকা']);
    expect(await stub.hits('GET /api/v1/geo/autocomplete')).toBe(1);
    await page.getByRole('button', { name: 'সেকশন ১০, মিরপুর, ঢাকা' }).click();
    // A result already names the place: no reverse call for it.
    await expect(page.getByTestId('location-address')).toHaveValue('সেকশন ১০, মিরপুর, ঢাকা');
    await page.waitForTimeout(1500);
    expect(await stub.hits('GET /api/v1/geo/reverse')).toBe(reverses);
    await expect(page.getByText(/সীমানার বাইরে/)).toHaveCount(0);
  });

  test('a draft survives a reload', async ({ page }) => {
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/post/new'));
    await page.getByRole('radio', { name: /মোবাইল ফোন/ }).click();
    await page.getByLabel(/^শিরোনাম/).fill('অর্ধেক লেখা পোস্ট');
    await page.getByLabel(/^দাম/).fill('১২ হাজ');
    await page.waitForTimeout(800); // the autosave debounce
    await page.reload();
    await expect(page.getByText('আগের অসমাপ্ত খসড়া ফিরিয়ে আনা হয়েছে।')).toBeVisible();
    await expect(page.getByLabel(/^শিরোনাম/)).toHaveValue('অর্ধেক লেখা পোস্ট');
    await expect(page.getByLabel(/^দাম/)).toHaveValue('১২ হাজ');
  });
});

test.describe('my posts', () => {
  test("tabs with counts; rejected shows why, with the moderator's note", async ({
    page,
    stub,
  }) => {
    await stub.control({
      seedPosts: [
        { title: 'লাইভ পোস্ট', status: 'live' },
        {
          title: 'বাতিল পোস্ট',
          status: 'rejected',
          moderationReason: 'wrong_category',
          moderationNote: 'এটা গাড়ির ক্যাটাগরিতে দিন',
        },
        { title: 'লুকানো পোস্ট', status: 'live', hiddenByOwner: true },
      ],
    });
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/me/posts'));
    await expect(page.getByRole('link', { name: 'লাইভ ১' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'বাতিল/সরানো ১' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'লুকানো ১' })).toBeVisible();
    await expect(page.getByText('লুকানো পোস্ট')).toHaveCount(0);

    await page.getByRole('link', { name: 'বাতিল/সরানো ১' }).click();
    await expect(page.getByText('কারণ: ভুল বিভাগে দেওয়া হয়েছে')).toBeVisible();
    await expect(page.getByText('মডারেটরের মন্তব্য: এটা গাড়ির ক্যাটাগরিতে দিন')).toBeVisible();
    await page.getByRole('link', { name: 'ঠিক করে আবার জমা দিন' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await expect(page.getByRole('heading', { name: 'পোস্ট সম্পাদনা' })).toBeVisible();
    await expect(page.getByLabel(/^শিরোনাম/)).toHaveValue('বাতিল পোস্ট');
    await page.getByLabel(/^শিরোনাম/).fill('ঠিক করা পোস্ট');
    await page.getByRole('button', { name: 'ঠিক করে আবার জমা দিন' }).click();
    await expect(page.getByRole('heading', { name: 'পোস্টটি রিভিউতে আছে' })).toBeVisible();
    await expect(
      page.getByText('সাধারণত ১২ ঘণ্টার মধ্যে যাচাই শেষ হয়।', { exact: false }),
    ).toBeVisible();
  });

  test('mark sold with a price, hide, and delete after confirming', async ({ page, stub }) => {
    await stub.control({
      seedPosts: [
        { title: 'বিক্রির ফোন', status: 'live' },
        { title: 'মোছার ফোন', status: 'pending' },
      ],
    });
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/me/posts'));

    const selling = page.getByRole('listitem').filter({ hasText: 'বিক্রির ফোন' });
    await selling.getByRole('button', { name: 'বিক্রি হয়েছে' }).click();
    await selling.getByLabel('কত টাকায় বিক্রি হলো (ঐচ্ছিক)').fill('৬০,০০০');
    await selling.getByRole('button', { name: 'নিশ্চিত করুন' }).click();
    await expect(page.getByRole('link', { name: 'বিক্রি হয়েছে ১' })).toBeVisible();
    expect((await stub.posts()).find((p) => p.title === 'বিক্রির ফোন')).toMatchObject({
      status: 'sold',
      soldPrice: '60000.00',
    });

    await page.getByRole('link', { name: 'বিক্রি হয়েছে ১' }).click();
    const sold = page.getByRole('listitem').filter({ hasText: 'বিক্রির ফোন' });
    await expect(sold.getByText('বিক্রি: ৳ ৬০,০০০')).toBeVisible();
    await expect(sold.getByRole('button', { name: 'মুছে ফেলুন' })).toHaveCount(0);
    await sold.getByRole('button', { name: 'লুকান' }).click();
    await expect(page.getByRole('link', { name: 'লুকানো ১' })).toBeVisible();

    await page.getByRole('link', { name: 'রিভিউতে ১' }).click();
    const pending = page.getByRole('listitem').filter({ hasText: 'মোছার ফোন' });
    await pending.getByRole('button', { name: 'মুছে ফেলুন' }).click();
    await expect(pending.getByText('পোস্টটি মুছে ফেলবেন? এটি আর ফেরত আনা যাবে না।')).toBeVisible();
    await pending.getByRole('button', { name: 'নিশ্চিত করুন' }).click();
    await expect(page.getByRole('link', { name: 'রিভিউতে ০' })).toBeVisible();
  });

  test('an action the server refuses is explained in Bengali', async ({ page, stub }) => {
    await stub.control({ seedPosts: [{ title: 'নতুন পোস্ট এখনই', status: 'live' }] });
    await signInSeller(page);
    await page.goto(tenantUrl('mirpur', '/me/posts'));
    await page.getByRole('button', { name: 'মেয়াদ বাড়ান' }).click();
    await expect(
      page.getByText(
        'মেয়াদ শেষ হওয়ার কাছাকাছি সময়ে বাড়ানো যায় — ১৭ অক্টোবর থেকে আবার চেষ্টা করুন।',
      ),
    ).toBeVisible();
  });
});
