import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { SearchQueryRepository, type ZeroResultQuery } from '../query/search-query.repository';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { toMeilisearchSynonyms } from '../synonyms/synonym-dictionary';
import { hasBengali, searchWords } from '../text/normalize';
import { transliterate } from '../text/transliterate';
import { SearchCliModule } from './search-cli.module';

/**
 * `pnpm --filter @amar-elaka/api search:zero-results [--days N] [--limit N]`
 * (in the image: `node dist/search/cli/zero-results.js`).
 *
 * The synonym workflow (docs/specs/search-synonyms.md): lists the queries
 * that found nothing in the last search_zero_result_report_days (7) across
 * every tenant, most distinct searchers first, as a Markdown table. For each,
 * it shows which words the dictionary already knows, and the Banglish of a
 * Bengali query, so a missing synonym is easy to spot. Add the line to
 * search-synonyms.md, run `search:synonyms`, and redeploy.
 *
 * Reads search_queries as the `system` role (the platform-read policy);
 * only normalized queries are ever stored, so nothing here identifies anyone.
 */

const MS_PER_DAY = 86_400_000; // settings-exempt: unit conversion

export function parseFlag(argv: readonly string[], name: string): number | undefined {
  const flag = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (flag === -1) return undefined;
  const raw = argv[flag]!.includes('=') ? argv[flag]!.split('=')[1]! : (argv[flag + 1] ?? '');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} takes a positive whole number`);
  }
  return value;
}

/** The report as Markdown: one row per query. Pure, for tests. */
export function formatReport(
  rows: readonly ZeroResultQuery[],
  known: Readonly<Record<string, readonly string[]>>,
  days: number,
): string {
  const lines = [
    `# Zero-result searches, last ${days} days`,
    '',
    rows.length === 0
      ? 'None: every search found something.'
      : '| Query | Banglish | Searchers | Searches | Tenants | Words the dictionary knows |',
  ];
  if (rows.length > 0) lines.push('| --- | --- | ---: | ---: | ---: | --- |');
  for (const row of rows) {
    const words = searchWords(row.q_normalized);
    const knownWords = words.filter((w) => known[w] !== undefined);
    lines.push(
      `| ${cell(row.q_normalized)} | ${hasBengali(row.q_normalized) ? cell(transliterate(row.q_normalized)) : ''} | ${row.searchers} | ${row.searches} | ${row.tenants} | ${knownWords.length > 0 ? cell(knownWords.join(', ')) : '—'} |`,
    );
  }
  return lines.join('\n');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  // settings-exempt: argv offset (node, script)
  const argv = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(SearchCliModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  try {
    const settings = app.get(SettingsService);
    const days = parseFlag(argv, 'days') ?? (await settings.get('search_zero_result_report_days'));
    const limit =
      parseFlag(argv, 'limit') ?? (await settings.get('search_zero_result_report_limit'));
    const repo = app.get(SearchQueryRepository);
    const rows = await app
      .get(TenantContext)
      .run({ role: 'system' }, () =>
        app
          .get(TenantDb)
          .transaction(
            (tx) => repo.zeroResultQueries(tx, new Date(Date.now() - days * MS_PER_DAY), limit),
            { accessMode: 'read only' },
          ),
      );
    console.log(formatReport(rows, toMeilisearchSynonyms(SYNONYM_LINES), days));
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
