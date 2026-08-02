/**
 * Vitest Configuration for KittenKong
 *
 * PURPOSE:
 * Configures the Vitest testing framework for the KittenKong TypeScript client.
 * Enables TypeScript support, coverage reporting, and proper test environment setup.
 *
 * VERSION HISTORY:
 * - 2025-04-02: Initial configuration with TypeScript support and coverage
 * - 2026-08-01: globalSetup starts an isolated FunkyGibbon on an ephemeral
 *   port so integration tests never touch a real install or collide on 8000.
 *   Timeouts raised because those tests do real HTTP round trips.
 *
 * DEPENDENCIES:
 * - vitest: Test runner and assertion library
 * - @vitest/coverage-v8: Code coverage reporting
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.spec.ts',
        '**/*.test.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@the-goodies/inbetweenies': resolve(__dirname, '../inbetweenies/src')
    }
  }
});
