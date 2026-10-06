import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The server's compiled code is plain Node ESM; load it as it is instead of transforming it for every test file.
    server: { deps: { external: [/[\\/]packages[\\/]server[\\/]dist[\\/]/, /@ragforge[\\/]server/] } },
  },
});
