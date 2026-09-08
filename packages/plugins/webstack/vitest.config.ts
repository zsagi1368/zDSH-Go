import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests must never touch the real network; live probes (if ever
    // added) are env-gated and skipped by default.
    restoreMocks: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
