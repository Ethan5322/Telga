import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Stress configuration.
 *
 * Kept out of the default suite so a long soak never slows an ordinary run,
 * and so the stress file can be pointed at deliberately.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/stress/**/*.stress.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
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
