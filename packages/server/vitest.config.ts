import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The app talks to a real SQLite file and a real HTTP stub server, so
    // parallel files would fight over both.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-secret-value-at-least-sixteen-chars',
    },
  },
});
