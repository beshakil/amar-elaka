import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * CLAUDE.md hard rule 9: no duration, limit, threshold or price is hardcoded
 * in application code; it belongs in platform_settings (read via
 * SettingsService). This test fails on any numeric literal other than 0 and 1
 * in business-logic source.
 *
 * Escape hatches, both reviewed in code review:
 * - INFRASTRUCTURE_PATHS: whole areas that aren't business logic, each with a reason.
 * - `// settings-exempt: <reason>` on the same or preceding line, for a
 *   structural number that governs no behaviour.
 */

const SRC_ROOT = join(__dirname, '..');
const EXEMPT_MARKER = 'settings-exempt:';
const STRUCTURAL_VALUES = new Set([0, 1]);

const INFRASTRUCTURE_PATHS: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'main.ts', reason: 'application bootstrap wiring' },
  {
    prefix: 'openapi/',
    reason: 'build tooling that writes the OpenAPI document (argv indices, JSON indentation)',
  },
  { prefix: 'config/', reason: 'environment parsing: ports, key lengths, env defaults' },
  { prefix: 'health/', reason: 'health-probe timeouts and reconnect backoff' },
  { prefix: 'common/', reason: 'HTTP status codes and generic timeout/retry helpers' },
  {
    prefix: 'database/schema/',
    reason:
      'Drizzle mirror of the SQL migrations: numeric(precision, scale) etc. are column ' +
      'TYPE definitions, not business thresholds — the number lives in the migration, this ' +
      'just has to say the same thing in TypeScript for the drift test.',
  },
  {
    prefix: 'database/seed/',
    reason:
      'Dev-only fixture data (db:seed) — row counts, fake price ranges, blood-group indices ' +
      'and the like describe fabricated sample data, not platform behaviour; nothing here is ' +
      'read by application code at runtime.',
  },
];

interface Finding {
  file: string;
  line: number;
  literal: string;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function isInfrastructure(relativePath: string): boolean {
  return INFRASTRUCTURE_PATHS.some(({ prefix }) => relativePath.startsWith(prefix));
}

export function findHardcodedNumbers(file: string, source: string): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const lines = source.split('\n');
  const findings: Finding[] = [];

  const isExempt = (lineIndex: number): boolean =>
    (lines[lineIndex] ?? '').includes(EXEMPT_MARKER) ||
    (lines[lineIndex - 1] ?? '').trim().startsWith(`// ${EXEMPT_MARKER}`);

  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const literal = node.getText(sourceFile);
      const value = Number(literal.replace(/_/g, '').replace(/n$/, ''));
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (!STRUCTURAL_VALUES.has(value) && !isExempt(line)) {
        findings.push({ file, line: line + 1, literal });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
    const isSource =
      entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts');
    return isSource ? [fullPath] : [];
  });
}

describe('No hardcoded numbers in business logic (CLAUDE.md rule 9)', () => {
  it('finds no numeric literals other than 0/1 outside infrastructure paths', () => {
    const findings = listSourceFiles(SRC_ROOT)
      .map((fullPath) => ({ fullPath, relativePath: toPosix(relative(SRC_ROOT, fullPath)) }))
      .filter(({ relativePath }) => !isInfrastructure(relativePath))
      .flatMap(({ fullPath, relativePath }) =>
        findHardcodedNumbers(relativePath, readFileSync(fullPath, 'utf8')),
      );

    expect(findings).toEqual([]);
  });

  it('gives every infrastructure exemption a reason', () => {
    for (const { reason } of INFRASTRUCTURE_PATHS) {
      expect(reason.trim()).not.toBe('');
    }
  });

  describe('scanner self-test', () => {
    it('flags a hardcoded duration', () => {
      expect(findHardcodedNumbers('x.ts', 'const graceDays = 15;')).toEqual([
        { file: 'x.ts', line: 1, literal: '15' },
      ]);
    });

    it('flags decimals, separators and bigints', () => {
      const source = 'const a = 0.5;\nconst b = 10_000;\nconst c = 7n;';
      expect(findHardcodedNumbers('x.ts', source).map((finding) => finding.literal)).toEqual([
        '0.5',
        '10_000',
        '7n',
      ]);
    });

    it('ignores 0, 1 and -1', () => {
      const source = 'const first = items[0];\nconst next = index + 1;\nconst missing = -1;';
      expect(findHardcodedNumbers('x.ts', source)).toEqual([]);
    });

    it('honours the settings-exempt marker on the same or preceding line', () => {
      const source = [
        'const bits = 64; // settings-exempt: hash width, not behaviour',
        '// settings-exempt: IPv4 octet count',
        'const octets = 4;',
        'const limit = 5;',
      ].join('\n');
      expect(findHardcodedNumbers('x.ts', source)).toEqual([
        { file: 'x.ts', line: 4, literal: '5' },
      ]);
    });

    it('treats only the listed paths as infrastructure', () => {
      expect(isInfrastructure('config/env.schema.ts')).toBe(true);
      expect(isInfrastructure('common/utils/with-timeout.ts')).toBe(true);
      expect(isInfrastructure('settings/settings.service.ts')).toBe(false);
      expect(isInfrastructure('posts/posts.service.ts')).toBe(false);
    });
  });
});
