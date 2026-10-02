import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Every e2e file opens its own connection to the same migrated SQLite
    // file, and the 50-player ones write hard. In parallel they hit
    // SQLITE_BUSY (see the matching comment in vitest.config.ts), so run one
    // file at a time.
    fileParallelism: false,
    globalSetup: ['./test/vitest-global-setup.ts'],
  },
});
