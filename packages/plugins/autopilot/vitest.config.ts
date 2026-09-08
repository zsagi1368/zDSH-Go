import { defaultExclude, defineConfig } from 'vitest/config'

// Backup area (del/) must never be picked up as test sources.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, 'del/**'],
  },
})
