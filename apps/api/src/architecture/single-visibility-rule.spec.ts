import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * One visibility rule (month 2 review §6, migration 0049): SQL decides
 * whether a post is shown through public.post_is_listed() (feed, map,
 * search, discovery) or public.post_is_viewable() (the post page), never by
 * spelling out status/deleted/hidden/expiry again. The copies drifted once:
 * the map kept expired posts the feed had already dropped.
 */

const SRC_ROOT = join(__dirname, '..');

/** Hand-written pieces of the rule inside SQL text. */
const HAND_WRITTEN = [
  /\bnot\s+(?:\w+\.)?hidden_by_owner\b/i,
  /\bstatus_code\s*(?:=|in)\s*\(?\s*'live'/i,
];

/** SQL that tests 'live' for something other than "is it shown". */
const NOT_VISIBILITY = new Map([
  ['posts/posts.repository.ts', 'the expiry job selects the live posts it expires'],
  ['trust/trust.repository.ts', 'trust counts a member’s published history'],
  ['moderation/moderation.repository.ts', 'the price-anomaly median samples recent prices'],
  ['database/seed/seed.ts', 'seed data, not a request path'],
]);

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

describe('one post visibility rule (0049)', () => {
  it('no SQL outside the allow-list spells the rule out by hand', () => {
    const offenders = files
      .filter((f) => !NOT_VISIBILITY.has(f.path))
      .filter((f) => HAND_WRITTEN.some((pattern) => pattern.test(f.source)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    const stale = [...NOT_VISIBILITY.keys()].filter(
      (path) => !files.some((f) => f.path === path && HAND_WRITTEN.some((p) => p.test(f.source))),
    );
    expect(stale).toEqual([]);
  });

  it('the scan sees the callers (guards the test itself)', () => {
    const callers = files.filter((f) => f.source.includes('public.post_is_listed(')).length;
    expect(callers).toBeGreaterThanOrEqual(6);
  });
});
