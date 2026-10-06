import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The geo provider layer's walls (ADR 044):
 *
 *   1. Only the geo layer itself (locations/geocoding/) and the module that
 *      wires it reach GeoService or a provider. A provider's answer goes back
 *      to the client and nowhere else — in particular, never into a write
 *      path: we store on posts/places only the address text the USER
 *      confirmed or edited, plus our own geo_area_id, and never bulk-copy
 *      provider results into our tables.
 *   2. Only the Barikoi provider (and the API's env defaults) knows Barikoi's host.
 */

const SRC_ROOT = join(__dirname, '..');
const GEO_LAYER = 'locations/geocoding/';
const WIRING = new Set([
  'locations/locations.module.ts',
  'locations/geocoding/geo-worker.module.ts',
]);
const PROVIDER_IMPORT =
  /from\s+['"][^'"]*(geocoding\/geo\.service|geo-provider\.port|geocoding\/providers\/|\.\/providers\/)[^'"]*['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC_ROOT).map((path) => ({
  path: relative(SRC_ROOT, path).split(sep).join('/'),
  source: readFileSync(path, 'utf8'),
}));

describe('geo provider boundary (ADR 044)', () => {
  it('nothing outside the geo layer imports GeoService or a provider', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith(GEO_LAYER) && !WIRING.has(f.path))
      .filter((f) => PROVIDER_IMPORT.test(f.source))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only the Barikoi provider names Barikoi's host", () => {
    const offenders = files
      .filter(
        (f) =>
          f.path !== 'locations/geocoding/providers/barikoi.provider.ts' &&
          f.path !== 'config/env.schema.ts',
      )
      .filter((f) => /barikoi\.xyz/i.test(f.source))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the scan sees the layer (guards the test itself)', () => {
    expect(files.some((f) => f.path === 'locations/geocoding/geo.service.ts')).toBe(true);
    expect(files.some((f) => PROVIDER_IMPORT.test(f.source))).toBe(true);
  });
});
