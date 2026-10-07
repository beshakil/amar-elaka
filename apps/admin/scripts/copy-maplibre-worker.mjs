// MapLibre GL 6 runs its tile parsing in a module Web Worker loaded from a URL
// next to its own module. Once webpack bundles maplibre-gl that URL is gone,
// so the worker (and the shared chunk it imports) is copied into public/,
// under the library's version so a browser cache never pairs an old worker
// with a new main bundle. components/map/maplibre.ts points setWorkerUrl here.
// Runs before `next dev` and `next build`; public/maplibre is git-ignored.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('maplibre-gl/package.json'));
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const outRoot = join(here, '..', 'public', 'maplibre');
const out = join(outRoot, version);
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(join(pkgDir, 'dist', file), join(out, file));
}
console.log(`maplibre-gl ${version} worker → public/maplibre/${version}/`);
