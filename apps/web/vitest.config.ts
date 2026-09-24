import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the app's pure logic (helpers, middleware decisions, schema
// contracts). Rendering and user flows are covered end to end in apps/e2e.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // src/lib/env.ts validates these at import time; placeholders are enough
    // for code under test that never makes a real request.
    env: {
      API_BASE_URL: 'http://api.test/api/v1',
      APP_ROOT_DOMAIN: 'localhost',
      SITE_ORIGIN: 'http://localhost:3001',
      STORAGE_PUBLIC_URL: 'http://storage.test/media',
    },
  },
});
