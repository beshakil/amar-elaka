import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { SearchIndexer } from '../indexing/search-indexer.service';
import { SEARCH_TYPES, type SearchType } from '../search.types';
import { SearchCliModule } from './search-cli.module';

/**
 * `pnpm --filter @amar-elaka/api search:reindex [--type posts,stores,places]`
 * (in the image: `node dist/search/cli/reindex.js`).
 *
 * Rebuilds the indexes from Postgres with no downtime: each type is loaded
 * into a fresh index while search keeps serving the old one, then swapped in
 * atomically, then anything changed during the build is re-synced. Also
 * (re)applies index settings and synonyms. Safe to run at any time; run it
 * after the first deploy of search and whenever documents change shape.
 */

export function parseTypes(argv: readonly string[]): SearchType[] {
  const flag = argv.findIndex((a) => a === '--type' || a.startsWith('--type='));
  if (flag === -1) return [...SEARCH_TYPES];
  const value = argv[flag]!.includes('=') ? argv[flag]!.split('=')[1]! : (argv[flag + 1] ?? '');
  const types = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const unknown = types.filter((t) => !(SEARCH_TYPES as readonly string[]).includes(t));
  if (types.length === 0 || unknown.length > 0) {
    throw new Error(`--type takes a comma-separated list of: ${SEARCH_TYPES.join(', ')}`);
  }
  return types as SearchType[];
}

async function main(): Promise<void> {
  // settings-exempt: argv offset (node, script)
  const types = parseTypes(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(SearchCliModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  try {
    const counts = await app.get(SearchIndexer).reindex(types);
    for (const type of types) console.log(`${type}: ${counts[type]} documents indexed`);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  // A one-shot command: exit explicitly, so a connection pool left open by a
  // failed start-up can't keep the process (and a deploy step) hanging.
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
