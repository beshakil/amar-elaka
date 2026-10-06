import { defineConfig } from 'vitest/config';

// Style validation against the MapLibre style spec, label switching, and the
// generated files' copies in the Flutter app staying identical.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
