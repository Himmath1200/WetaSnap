import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // The unit tests cover the demo backend, so they ignore a local .env.local that points the
    // app at the API (services/api).
    env: { VITE_API_URL: '' },
  },
});
