import { defineConfig } from 'vitest/config';

// Pure logic only (the CSV export); the components are exercised by the apps' Playwright suites.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
