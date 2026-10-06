import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_PORT = 8123;
const OLLAMA_PORT = 11999;
const repoRoot = resolve(__dirname, '../..');

// Playwright evaluates this file in every worker, so the data directory must be stable per run.
const dataDir = process.env.E2E_DATA_DIR ?? (process.env.E2E_DATA_DIR = mkdtempSync(join(tmpdir(), 'ragforge-e2e-')));
const forwardSlashes = (p: string) => p.split('\\').join('/');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    // Uses the Chrome installed on this machine, so no browser download is needed.
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/fake-ollama.mjs',
      cwd: __dirname,
      env: { FAKE_OLLAMA_PORT: String(OLLAMA_PORT) },
      url: `http://127.0.0.1:${OLLAMA_PORT}/api/tags`,
      reuseExistingServer: false,
    },
    {
      // The production build, started exactly like the container does.
      command: 'node packages/server/bin/ragforge.js',
      cwd: repoRoot,
      env: {
        NODE_ENV: 'production',
        PORT: String(APP_PORT),
        DATA_DIR: dataDir,
        SQLITE_URL: `file:${forwardSlashes(join(dataDir, 'e2e.db'))}`,
        JWT_SECRET: 'e2e-jwt-secret-that-is-long-enough-0123456789',
        ENCRYPTION_KEY: 'ab'.repeat(32),
        INGEST_CONCURRENCY: '2',
      },
      url: `http://localhost:${APP_PORT}/api/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
