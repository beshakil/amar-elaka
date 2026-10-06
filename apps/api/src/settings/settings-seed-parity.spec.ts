import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTING_DEFINITIONS } from './settings.registry';

/**
 * CLAUDE.md hard rule 9: adding a setting means a seed row plus a registry
 * entry in the same change. A registry key with no seed row makes
 * SettingsService.get() throw at runtime; a seed row with no registry key
 * can't be read type-safely. Statically parses the migrations so it runs in
 * the unit suite, without a database.
 */

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'infra', 'migrations');

// A seed row starts with `('<key>', '<json value>', '<value_type_code>'`.
const SEED_ROW = /^\s*\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'[^']*'\s*,\s*'([a-z_]+)'/gm;

// A later migration can retire a seed row: `DELETE FROM public.platform_settings WHERE key IN ('a', 'b')`.
const DELETED_ROWS = /DELETE FROM\s+public\.platform_settings\s+WHERE\s+key\s+IN\s*\(([^)]*)\)/gi;

function seededSettingKeys(): Set<string> {
  const keys = new Set<string>();
  // Migrations apply in file-name order, so a later DELETE retires an earlier seed.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of sql.matchAll(DELETED_ROWS)) {
      for (const key of match[1]!.matchAll(/'([a-z][a-z0-9_]*)'/g)) keys.delete(key[1]!);
    }
    // Only rows inside an INSERT INTO public.platform_settings statement.
    // Descriptions may contain ';', so a statement ends at the next INSERT
    // or the end of the file rather than at the first semicolon.
    for (const block of sql.split(/(?=INSERT INTO)/i)) {
      if (!/^INSERT INTO\s+public\.platform_settings\b/i.test(block)) continue;
      for (const match of block.matchAll(SEED_ROW)) keys.add(match[1]!);
    }
  }
  return keys;
}

describe('platform settings: registry ↔ seed parity', () => {
  const seeded = seededSettingKeys();
  const registered = new Set(Object.keys(SETTING_DEFINITIONS));

  it('finds seed rows at all (guards the parser itself)', () => {
    expect(seeded.size).toBeGreaterThan(Object.keys(SETTING_DEFINITIONS).length / 2);
  });

  it('seeds every registry key in a migration', () => {
    expect([...registered].filter((key) => !seeded.has(key)).sort()).toEqual([]);
  });

  it('registers every seeded key', () => {
    expect([...seeded].filter((key) => !registered.has(key)).sort()).toEqual([]);
  });
});
