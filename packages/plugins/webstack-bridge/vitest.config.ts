import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests must never touch the real network; every WS client here
    // connects to a 127.0.0.1 loopback port owned by the test itself.
    restoreMocks: true,
    include: ['tests/**/*.test.ts'],
  },
});
