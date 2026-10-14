import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The unit tests are pure functions; the database ones live in the smoke script.
    env: { SECRET_KEY: 'test-secret-key-at-least-16-characters', DATABASE_URL: 'postgres://x', SERVICE_DATABASE_URL: 'postgres://x' },
  },
});
