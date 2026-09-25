import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildClientFixtures } from './client-fixtures';

/** Writes the client form fixtures (client-fixtures.ts). Usage: pnpm fixtures:export */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

for (const [path, content] of Object.entries(buildClientFixtures())) {
  const target = join(REPO_ROOT, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${path}`);
}
