import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/**/*.spec.ts', 'ui/**/*.spec.tsx'],
    environment: 'node',
  },
})
