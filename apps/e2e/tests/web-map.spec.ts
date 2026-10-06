import type { Response } from '@playwright/test';
import { STUB_URL } from '../stub-api/fixtures';
import { expect, test, WEB } from './support';

/**
 * The self-hosted base map (ADR 043), headless: both styles from
 * @amar-elaka/map-style load over the PMTiles fixture (z0–6 of the real
 * Bangladesh build) with no MapLibre error, the archive is read with HTTP
 * range requests (206), and glyphs and sprites come from next to it. The page
 * is the Bengali shaping spike, /dev/map.
 */

const map = (page: import('@playwright/test').Page) => page.getByTestId('base-map');

test.describe('base map styles', () => {
  test('light and dark both load over the .pmtiles archive, in both label languages', async ({
    page,
    request,
  }) => {
    const archiveResponses: Response[] = [];
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('.pmtiles')) archiveResponses.push(response);
      if (response.url().startsWith(`${STUB_URL}/tiles/`) && response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${WEB}/dev/map`);
    await expect(map(page)).toHaveAttribute('data-map-state', 'ready', { timeout: 30_000 });
    await expect(map(page)).toHaveAttribute('data-map-loaded-style', 'light:bn');

    await page.getByTestId('theme-dark').click();
    await expect(map(page)).toHaveAttribute('data-map-loaded-style', 'dark:bn', {
      timeout: 30_000,
    });
    await page.getByTestId('lang-en').click();
    await expect(map(page)).toHaveAttribute('data-map-loaded-style', 'dark:en', {
      timeout: 30_000,
    });
    await page.getByTestId('theme-light').click();
    await expect(map(page)).toHaveAttribute('data-map-loaded-style', 'light:en', {
      timeout: 30_000,
    });

    await expect(map(page)).toHaveAttribute('data-map-errors', '0');
    expect(failures).toEqual([]);
    expect(consoleErrors.filter((e) => /map error|map failed/.test(e))).toEqual([]);

    // The archive is only ever read in ranges: no whole-file download.
    expect(archiveResponses.length).toBeGreaterThan(0);
    for (const response of archiveResponses) expect(response.status()).toBe(206);
    const stats = (await (await request.get(`${STUB_URL}/__stats`)).json()) as {
      map: { ranges: number; misses: string[] };
    };
    expect(stats.map.misses).toEqual([]);
  });

  test('shows the OpenStreetMap and Protomaps attribution, uncollapsed', async ({ page }) => {
    await page.goto(`${WEB}/dev/map`);
    await expect(map(page)).toHaveAttribute('data-map-state', 'ready', { timeout: 30_000 });
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    await expect(attribution).toContainText('© OpenStreetMap contributors');
    await expect(attribution).toContainText('Protomaps');
    await expect(attribution).not.toHaveClass(/maplibregl-compact/);
    await expect(
      attribution.getByRole('link', { name: 'OpenStreetMap contributors' }),
    ).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  });

  test('the shaping page shows the six names as HTML text to compare against', async ({ page }) => {
    await page.goto(`${WEB}/dev/map`);
    const reference = page.getByTestId('html-reference');
    for (const name of [
      'ক্রিসেন্ট লেক',
      'শ্যামলী',
      'ধানমন্ডি ২৭',
      'চট্টগ্রাম',
      'ব্রাহ্মণবাড়িয়া',
      'কক্সবাজার',
    ]) {
      await expect(reference.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('label-setting')).toContainText('en');
  });
});
