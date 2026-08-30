import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // ELEG-64: restores a working `localStorage` under jsdom. Node 26 shadows jsdom's
    // own; see the setup file for the measurement and why this is the fix.
    setupFiles: ['src/__tests__/setup/jsdom-localstorage.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
