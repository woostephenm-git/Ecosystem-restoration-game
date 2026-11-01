import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Scenario tests play whole three-year missions, often two per test.
    testTimeout: 60_000,
  },
});
