import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    // The stress soak has its own config; it must never slow an ordinary run.
    exclude: ['tests/stress/**', 'node_modules/**', 'dist/**'],
    // A **resource** budget, not a way to let a slow test pass. Every test is
    // deterministic — clocks and schedulers are injected, nothing sleeps — but
    // they are backed by a real SQLite file and some spawn real processes.
    // Vitest's 5-second default is fair for a pure unit test on an idle machine
    // and far too tight for a database-backed one on a two-core box, where it
    // fails on CPU contention rather than on behaviour. See A51.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@telga/api': resolve('./services/api/src/index.ts'),
      '@telga/worker': resolve('./services/worker/src/index.ts'),
      '@telga/backup': resolve('./services/backup/src/index.ts'),
      '@telga/domain': resolve('./packages/domain/src/index.ts'),
      '@telga/persistence': resolve('./packages/persistence/src/index.ts'),
      '@telga/localization': resolve('./packages/localization/src/index.ts'),
      '@telga/pos-view-model': resolve('./packages/pos-view-model/src/index.ts'),
      '@telga/merchant-pos': resolve('./apps/merchant-pos/src/index.ts'),
      '@telga/provider-mock-airtime': resolve('./services/provider-adapters/mock-airtime/src/index.ts'),
    },
  },
});
