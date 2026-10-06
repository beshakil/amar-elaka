import { STUB_URL } from '../stub-api/fixtures';
import { expect, tenantUrl, test } from './support';

/**
 * The area map (/map, ADR 044, 045): the API's GeoJSON features, clustered
 * on the server for the viewport, on our base map; a list view of the same items for keyboards and
 * screen readers; a card per point; and a route only on an explicit tap.
 */

interface Stats {
  hits: Record<string, number>;
  map: { lastQuery: Record<string, string> | null };
}

test.describe('area map', () => {
  test.use({ geolocation: { latitude: 23.8, longitude: 90.36 }, permissions: ['geolocation'] });

  test('asks for the viewport, lists clusters and points, opens a card, routes only on a tap', async ({
    page,
    request,
  }) => {
    const stats = async () => (await (await request.get(`${STUB_URL}/__stats`)).json()) as Stats;
    await page.goto(tenantUrl('mirpur', '/map'));
    await expect(page.getByTestId('area-map')).toHaveAttribute('data-map-state', 'ready', {
      timeout: 30_000,
    });

    // The viewport, its zoom and every layer went to GET /map/features.
    await expect
      .poll(async () => (await stats()).map.lastQuery)
      .toMatchObject({ layers: 'posts,stores,places,landmarks,info' });
    const query = (await stats()).map.lastQuery!;
    expect(query.bbox!.split(',')).toHaveLength(4);
    expect(Number(query.zoom)).toBeGreaterThan(10);

    const list = page.getByTestId('map-list');
    await list.locator('summary').click();
    await expect(
      list.getByRole('button', { name: '১২টি বিজ্ঞাপন — কাছ থেকে দেখুন' }),
    ).toBeVisible();
    await expect(list.getByRole('button', { name: 'মিরপুর স্টেডিয়াম' })).toBeVisible();

    await list.getByRole('button', { name: 'আইফোন ১৩, ১২৮ জিবি' }).click();
    const card = page.getByTestId('map-card');
    await expect(card.getByRole('heading', { name: 'আইফোন ১৩, ১২৮ জিবি' })).toBeVisible();
    await expect(card.getByText('৳ ৬৫,০০০')).toBeVisible();
    await expect(card.getByRole('link', { name: 'বিস্তারিত দেখুন' })).toHaveAttribute(
      'href',
      /^\/listing\/0191e3a0-0000-7000-8000-00000000e001\//,
    );

    // Opening a card costs nothing: the route is a paid call, asked for by a tap.
    expect((await stats()).hits['POST /api/v1/geo/route'] ?? 0).toBe(0);
    await card.getByRole('button', { name: 'হেঁটে রাস্তা দেখুন' }).click();
    await expect(card.getByTestId('route-status')).toContainText('২ কিমি');
    await expect(card.getByTestId('route-status')).toContainText('প্রায় ৩০ মিনিট');
    await expect(card.getByTestId('barikoi-attribution')).toBeVisible();
    expect((await stats()).hits['POST /api/v1/geo/route']).toBe(1);
  });

  test('a landmark has no listing link; the layer toggle and open now ask again', async ({
    page,
    request,
  }) => {
    await page.goto(tenantUrl('mirpur', '/map'));
    await expect(page.getByTestId('area-map')).toHaveAttribute('data-map-state', 'ready', {
      timeout: 30_000,
    });
    const list = page.getByTestId('map-list');
    await list.locator('summary').click();
    await list.getByRole('button', { name: 'মিরপুর স্টেডিয়াম' }).click();
    const card = page.getByTestId('map-card');
    await expect(card.getByText('ল্যান্ডমার্ক')).toBeVisible();
    await expect(card.getByRole('link', { name: 'বিস্তারিত দেখুন' })).toHaveCount(0);

    await expect(card.getByText('এখন বন্ধ')).toBeVisible();

    const lastQuery = async () =>
      ((await (await request.get(`${STUB_URL}/__stats`)).json()) as Stats).map.lastQuery;
    await page.getByTestId('layer-posts').click();
    await expect.poll(async () => (await lastQuery())?.layers).toBe('stores,places,landmarks,info');
    await expect(list.getByRole('button', { name: 'আইফোন ১৩, ১২৮ জিবি' })).toHaveCount(0);

    // Open now: the closed landmark goes, the 24h pharmacy stays; the
    // layers without opening hours are named as skipped.
    await page.getByTestId('layer-posts').click();
    await page.getByTestId('open-now').click();
    await expect.poll(async () => (await lastQuery())?.open_now).toBe('true');
    await expect(list.getByRole('button', { name: 'মিরপুর স্টেডিয়াম' })).toHaveCount(0);
    await expect(list.getByRole('button', { name: 'মিরপুর ২৪ ঘণ্টা ফার্মেসি' })).toBeVisible();
    await expect(page.getByTestId('open-now-skipped')).toContainText('বিজ্ঞাপন, দোকান');
  });
});
