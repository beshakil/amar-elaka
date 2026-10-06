import type { Page } from '@playwright/test';
import { STUB_URL } from '../stub-api/fixtures';
import { expect, tenantUrl, test } from './support';

/**
 * The area map (/map, ADR 044–046), the web's Map tab: server-side clusters
 * for the toggled map_kinds, a list of the same results, a preview panel
 * with Bengali names in HTML, "এই এলাকায় খুঁজুন" instead of refetching per
 * pan, a road distance only on a click (once per session), Google Maps
 * directions, and a URL that holds the view.
 */

interface Stats {
  hits: Record<string, number>;
  map: { lastQuery: Record<string, string> | null };
}

const FEATURES = 'GET /api/v1/map/features';
const ROUTE = 'POST /api/v1/geo/route';

async function stats(page: Page): Promise<Stats> {
  return (await (await page.request.get(`${STUB_URL}/__stats`)).json()) as Stats;
}

async function openMap(page: Page, path = '/map') {
  await page.goto(tenantUrl('mirpur', path));
  await expect(page.getByTestId('area-map')).toHaveAttribute('data-map-state', 'ready', {
    timeout: 30_000,
  });
  await expect.poll(async () => (await stats(page)).hits[FEATURES] ?? 0).toBeGreaterThan(0);
}

/** Drags the map by [dx, dy] pixels (fractions of its size), as a visitor would. */
async function drag(page: Page, dx: number, dy: number) {
  await page.getByTestId('area-map').scrollIntoViewIfNeeded();
  const box = (await page.getByTestId('area-map').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * box.width, y + dy * box.height, { steps: 12 });
  await page.mouse.up();
}

test.describe('area map', () => {
  test.use({ geolocation: { latitude: 23.8, longitude: 90.36 }, permissions: ['geolocation'] });

  test('every kind in one request; list and preview; the road once per session; directions', async ({
    page,
  }) => {
    await openMap(page);
    // One request on open, for every map_kinds toggle.
    expect((await stats(page)).hits[FEATURES]).toBe(1);
    expect((await stats(page)).map.lastQuery).toMatchObject({
      kinds: 'hospital,pharmacy,listings',
    });
    // The URL holds the view.
    await expect(page).toHaveURL(/[?&]lat=23\.\d+&lng=90\.\d+&z=\d/);

    await page.getByTestId('view-list').click();
    await expect(page).toHaveURL(/[?&]view=list/);
    const list = page.getByTestId('map-list');
    await expect(
      list.getByRole('button', { name: '১২টি বিজ্ঞাপন — কাছ থেকে দেখুন' }),
    ).toBeVisible();
    await list.getByRole('button', { name: 'মিরপুর জেনারেল হাসপাতাল' }).click();

    const preview = page.getByTestId('map-preview');
    // The name is HTML text (Bengali shaped by the browser), not map text.
    await expect(preview.getByTestId('map-preview-name')).toHaveText('মিরপুর জেনারেল হাসপাতাল');
    await expect(preview.getByText('এখন খোলা আছে')).toBeVisible();
    await expect(preview.getByText('রোড ৫, মিরপুর ১০')).toBeVisible();
    await expect(preview.getByTestId('map-preview-distance')).toHaveText('সোজা দূরত্ব ৮৭১ মিটার');
    await expect(preview.getByTestId('map-preview-call')).toHaveAttribute(
      'href',
      'tel:+8801799300555',
    );
    await expect(preview.getByTestId('map-preview-directions')).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=23.807%2C90.369',
    );

    // Opening a preview costs nothing; the road is asked for by its button, once.
    expect((await stats(page)).hits[ROUTE] ?? 0).toBe(0);
    await preview.getByTestId('map-preview-road').click();
    await expect(preview.getByTestId('route-status')).toContainText('২ কিমি');
    await expect(preview.getByTestId('route-status')).toContainText('প্রায় ৩০ মিনিট');
    await expect(preview.getByTestId('barikoi-attribution')).toBeVisible();
    expect((await stats(page)).hits[ROUTE]).toBe(1);

    await preview.getByRole('button', { name: 'বন্ধ করুন' }).click();
    await list.getByRole('button', { name: 'মিরপুর জেনারেল হাসপাতাল' }).click();
    await expect(page.getByTestId('route-status')).toContainText('২ কিমি');
    expect((await stats(page)).hits[ROUTE]).toBe(1);
    // Each opening asks our own API for the preview; never a provider.
    expect((await stats(page)).hits['GET /api/v1/map/features/places/:id']).toBe(2);
  });

  test('panning offers "এই এলাকায় খুঁজুন" and never refetches by itself', async ({ page }) => {
    await openMap(page);
    const before = (await stats(page)).hits[FEATURES]!;
    // Past map_search_area_move_ratio (0.3) of the viewport.
    await drag(page, -0.45, 0);
    await expect(page.getByTestId('map-search-area')).toBeVisible();
    // The URL followed the camera; the features did not.
    expect((await stats(page)).hits[FEATURES]).toBe(before);
    await page.getByTestId('map-search-area').click();
    await expect.poll(async () => (await stats(page)).hits[FEATURES]).toBe(before + 1);
    await expect(page.getByTestId('map-search-area')).toHaveCount(0);
  });
});

test.describe('area map, layers and shared links', () => {
  test('the layer panel asks again, the URL keeps it, open now names what it skips', async ({
    page,
  }) => {
    await openMap(page);
    await page.getByTestId('map-layers').click();
    const panel = page.getByTestId('map-layers-panel');
    await expect(panel.getByRole('button', { name: 'হাসপাতাল' })).toBeVisible();
    await panel.getByTestId('kind-listings').click();
    await panel.getByTestId('open-now').check();
    await panel.getByTestId('map-layers-apply').click();
    await expect
      .poll(async () => (await stats(page)).map.lastQuery)
      .toMatchObject({ kinds: 'hospital,pharmacy', open_now: 'true' });
    await expect(page).toHaveURL(/kinds=hospital%2Cpharmacy/);
    await expect(page).toHaveURL(/open=1/);
    await expect(page.getByTestId('open-now-skipped')).toBeVisible();
  });

  test('a shared link opens that view: centre, zoom, kinds and the list', async ({ page }) => {
    await page.goto(tenantUrl('mirpur', '/map?lat=23.81&lng=90.37&z=15&kinds=pharmacy&view=list'));
    await expect
      .poll(async () => (await stats(page)).map.lastQuery?.kinds, { timeout: 30_000 })
      .toBe('pharmacy');
    expect(Math.round(Number((await stats(page)).map.lastQuery!.zoom))).toBe(15);
    const list = page.getByTestId('map-list');
    await expect(list.getByRole('button', { name: 'মিরপুর ২৪ ঘণ্টা ফার্মেসি' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'মিরপুর জেনারেল হাসপাতাল' })).toHaveCount(0);
  });
});
