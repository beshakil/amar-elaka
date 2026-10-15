import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every DTO class name is unique across the API. Swagger keys its schemas by
 * class name, so two `ReviewQueueDto`s silently became one in
 * packages/shared-types/openapi.json — the places review queue's published
 * type was the reviews queue's for a while (found 2026-10-12). Request param
 * DTOs that already shared a name and never reach the schema list are
 * allowed below; nothing new should join them.
 */
const ALLOWED_DUPLICATES = new Set(['StoreIdParamDto']);

function dtoFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return dtoFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('DTO class names', () => {
  it('are unique across modules (OpenAPI schema names)', () => {
    const root = join(__dirname, '..');
    const seen = new Map<string, string[]>();
    for (const file of dtoFiles(root)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/export class (\w+Dto)\b/g)) {
        const name = match[1]!;
        seen.set(name, [...(seen.get(name) ?? []), relative(root, file)]);
      }
    }
    const duplicates = [...seen.entries()]
      .filter(([name, files]) => files.length > 1 && !ALLOWED_DUPLICATES.has(name))
      .map(([name, files]) => `${name}: ${files.join(', ')}`);
    expect(duplicates).toEqual([]);
  });
});
