import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/**/*.test.ts'],
  setupFiles: ['tests/helpers/isolate-auth.ts'],
  // Real Git integration fixtures spawn thousands of short-lived children. Bound
  // file concurrency; protocol races inside each test remain fully concurrent.
  maxWorkers: 2,
} });
