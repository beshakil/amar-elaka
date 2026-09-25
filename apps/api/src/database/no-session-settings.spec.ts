import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Guards the connection-pool leak boundary (see TenantDb).
 *
 * Session-level settings survive COMMIT and stay on the pooled connection,
 * so the next request that borrows it would inherit another request's tenant.
 * This test inspects every string and template literal (where SQL lives, so
 * comments don't count) in application source and fails on:
 *   - a session-level `SET [SESSION] app.…`
 *   - `set_config(…, false)` (session scope)
 *   - any `set_config(` or `SET LOCAL app.` outside src/database/tenant-db.ts,
 *     so the transaction-local wrapper stays the single place that writes them
 */

const SRC_ROOT = join(__dirname, '..');
const WRAPPER_FILE = 'database/tenant-db.ts';
/**
 * database/seed/: standalone maintenance scripts (`db:seed`, `db:reset`),
 * never imported by or reachable from the running API. Each opens its own
 * short-lived `{ max: 1 }` connection for the one script run and exits —
 * there's no shared pool for a session-level app.* setting to leak across,
 * which is the only risk this test guards against.
 */
const EXEMPT_DIR_PREFIXES = [
  'database/seed/',
  // `geo:import` — the same kind of standalone script (also run by db:seed and
  // the DB tests), not imported by any API module.
  'locations/geo-import/',
];

interface Violation {
  file: string;
  line: number;
  rule: string;
}

const RULES: ReadonlyArray<{
  rule: string;
  pattern: RegExp;
  allowedIn?: string;
}> = [
  { rule: 'session-level SET app.*', pattern: /\bset\s+(session\s+)?app\./i },
  {
    rule: 'set_config with is_local = false',
    pattern: /set_config\s*\([^)]*,\s*false\s*\)/i,
  },
  {
    rule: 'set_config outside TenantDb',
    pattern: /set_config\s*\(/i,
    allowedIn: WRAPPER_FILE,
  },
  {
    rule: 'SET LOCAL app.* outside TenantDb',
    pattern: /\bset\s+local\s+app\./i,
    allowedIn: WRAPPER_FILE,
  },
];

export function findSessionSettingViolations(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  const check = (node: ts.Node, text: string): void => {
    for (const { rule, pattern, allowedIn } of RULES) {
      if (allowedIn === file) continue;
      if (pattern.test(text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ file, line: line + 1, rule });
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        '?',
      );
      check(node, text);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [fullPath] : [];
  });
}

describe('No session-level settings (connection-pool leak guard)', () => {
  it('finds no session-scoped app.* settings in application source', () => {
    const violations = listSourceFiles(SRC_ROOT)
      .map((fullPath) => relative(SRC_ROOT, fullPath).split(sep).join('/'))
      .filter((relPath) => !EXEMPT_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix)))
      .flatMap((relPath) =>
        findSessionSettingViolations(relPath, readFileSync(join(SRC_ROOT, relPath), 'utf8')),
      );
    expect(violations).toEqual([]);
  });

  it('allows only the transaction-local form inside TenantDb', () => {
    const wrapper = "sql`select set_config('app.tenant_id', ${id}, true)`";
    expect(findSessionSettingViolations(WRAPPER_FILE, wrapper)).toEqual([]);
  });

  describe('scanner self-test', () => {
    it('flags a session-level SET', () => {
      expect(
        findSessionSettingViolations('posts/x.ts', "await sql.unsafe('SET app.tenant_id = 1')"),
      ).toEqual([{ file: 'posts/x.ts', line: 1, rule: 'session-level SET app.*' }]);
    });

    it('flags session-scoped set_config, even inside TenantDb', () => {
      const code = "sql`select set_config('app.tenant_id', ${id}, false)`";
      expect(findSessionSettingViolations(WRAPPER_FILE, code).map((v) => v.rule)).toEqual([
        'set_config with is_local = false',
      ]);
    });

    it('flags set_config and SET LOCAL outside TenantDb', () => {
      const code = [
        "sql`select set_config('app.role', ${role}, true)`",
        "tx.execute(sql.raw('SET LOCAL app.user_id = 1'))",
      ].join('\n');
      expect(findSessionSettingViolations('posts/x.ts', code).map((v) => v.rule)).toEqual([
        'set_config outside TenantDb',
        'SET LOCAL app.* outside TenantDb',
      ]);
    });

    it('ignores comments', () => {
      expect(
        findSessionSettingViolations('posts/x.ts', '// never run SET app.tenant_id in a session'),
      ).toEqual([]);
    });
  });
});
