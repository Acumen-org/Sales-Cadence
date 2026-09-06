import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/setup-file.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 180000,
  },
});
