import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walks up from `startDir` looking for a `.env` file. The monorepo keeps a
 * single root `.env`, but this app's cwd differs between `turbo`/`nest`
 * (apps/api) and the Docker image (repo root) — so we search instead of
 * hardcoding a relative path.
 */
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;

  const eq = trimmed.indexOf('=');
  if (eq === -1) return undefined;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  const isQuoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (isQuoted) value = value.slice(1, -1);

  return [key, value];
}

/**
 * Loads `.env` into `process.env`, without overriding variables the real
 * environment already set (Docker/Coolify inject those directly, and they
 * must win over a stale or absent `.env` file).
 */
export function loadDotenv(): void {
  const envFile = findEnvFile(process.cwd());
  if (!envFile) return;

  const contents = readFileSync(envFile, 'utf8');
  for (const line of contents.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
