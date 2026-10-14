import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/**/*.spec.ts'],
    environment: 'node',
  },
})
