import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Every spec file opens its own connection to the same dev.db, and in
    // parallel they contend: SQLITE_BUSY, and a Prisma SocketTimeout that
    // reproduces within ~12 runs with this left on. WAL plus busy_timeout
    // reduced it but cannot remove it, because SQLite still serializes
    // writers. One file at a time costs about a second.
    //
    // This was only half the flakiness. The other half was supertest calling
    // listen() per request; see the comment in sessions.controller.spec.ts.
    fileParallelism: false,
    globalSetup: ['./test/vitest-global-setup.ts'],
  },
});
