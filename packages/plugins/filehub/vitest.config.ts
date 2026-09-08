import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'tests/**/*.spec.ts',
      'tests/**/*.spec.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    },
  },
})
