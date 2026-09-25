import { defineConfig } from 'vitest/config';

// Pure logic (zod builder, numerals, visibility, filters) and the parity
// check against the server's own verdicts in fixtures/validation-cases.json.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
